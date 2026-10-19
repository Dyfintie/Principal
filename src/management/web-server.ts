import http from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { managementRpc } from './client.js';

export interface WebServerOptions {
  port?: number;
  host?: string;
  open?: boolean;
}

export function getNetworkAddresses(): Array<{ name: string; address: string }> {
  const ifaces = os.networkInterfaces();
  const addresses: Array<{ name: string; address: string }> = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list) continue;
    for (const info of list) {
      if (info.family === 'IPv4' && !info.internal) {
        addresses.push({ name, address: info.address });
      }
    }
  }
  return addresses;
}

export async function loadDashboardHtml(): Promise<string> {
  const distUrl = new URL('./web/dashboard.html', import.meta.url);
  const srcUrl = new URL('../../src/management/web/dashboard.html', import.meta.url);
  try {
    return await readFile(distUrl, 'utf8');
  } catch {
    return await readFile(srcUrl, 'utf8');
  }
}

export function openBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else if (platform === 'win32') {
      spawn('powershell.exe', ['Start-Process', url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    // Ignore browser open failures (headless / remote environments)
  }
}

export async function startWebServer(options: WebServerOptions = {}): Promise<{
  url: string;
  server: http.Server;
  close: () => Promise<void>;
}> {
  const port = options.port ?? 7700;
  const host = options.host ?? '127.0.0.1';
  let htmlContent = await loadDashboardHtml();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const pathname = url.pathname;

    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    // CORS for local loopback
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Principal-Request',
      });
      res.end();
      return;
    }

    // 1. Dashboard Landing Page
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(htmlContent);
      return;
    }

    // 2. Health check
    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: '0.1.5' }));
      return;
    }

    // 3. Snapshot endpoint
    if (pathname === '/api/snapshot' && req.method === 'GET') {
      try {
        const snapshot = await managementRpc('snapshot');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(snapshot));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 4. Doctor endpoint
    if (pathname === '/api/doctor' && req.method === 'GET') {
      try {
        const report = await managementRpc('diagnostics.report');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 5. CSRF-protected JSON-RPC proxy
    if (pathname === '/api/rpc' && req.method === 'POST') {
      // Enforce custom header to prevent CSRF from untrusted websites
      if (req.headers['x-principal-request'] !== '1') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: Missing X-Principal-Request header' }));
        return;
      }

      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
          req.destroy();
        }
      });

      req.on('end', async () => {
        try {
          const { method, params } = JSON.parse(body);
          if (!method || typeof method !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid RPC method' }));
            return;
          }
          const result = await managementRpc(method, params ?? {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result }));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 6. Server-Sent Events (SSE) for Real-Time Live Sync
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      });
      res.write(': connected\n\n');

      let active = true;
      const sendUpdate = async () => {
        if (!active) return;
        try {
          const [snapshot, resources] = await Promise.all([
            managementRpc('snapshot'),
            managementRpc('resources').catch(() => []),
          ]);
          if (!active) return;
          res.write(`data: ${JSON.stringify({ snapshot, resources })}\n\n`);
        } catch {
          // Ignore transient poll errors
        }
      };

      // Send initial state immediately
      void sendUpdate();

      // Poll periodically for live changes (every 3 seconds)
      const timer = setInterval(() => {
        void sendUpdate();
      }, 3000);

      const heartbeat = setInterval(() => {
        if (!active) return;
        res.write(': ping\n\n');
      }, 15000);

      req.on('close', () => {
        active = false;
        clearInterval(timer);
        clearInterval(heartbeat);
      });
      return;
    }

    // Fallback 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const boundAddress = server.address();
  const actualPort = typeof boundAddress === 'object' && boundAddress ? boundAddress.port : port;
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`;

  if (options.open !== false) {
    openBrowser(url);
  }

  return {
    url,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export async function startWebCommand(argv: string[]): Promise<void> {
  let port = 7700;
  let host = '127.0.0.1';
  let shouldOpen = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') {
      port = parseInt(argv[++i], 10);
    } else if (arg === '--host' || arg === '-h') {
      host = argv[++i];
    } else if (arg === '--no-open') {
      shouldOpen = false;
    } else if (arg === '--tailscale') {
      const addresses = getNetworkAddresses();
      const ts = addresses.find((a) => a.name.includes('tailscale'));
      if (ts) {
        host = ts.address;
      } else {
        host = '0.0.0.0';
      }
    }
  }

  console.log('🚀 Starting Principal Web Management Server...');
  const { url, close } = await startWebServer({ port, host, open: shouldOpen });

  const addresses = getNetworkAddresses();
  const tailscale = addresses.find((a) => a.name.includes('tailscale'));

  console.log(`
================================================================
       🌐 Principal Web Management Dashboard is Running!
================================================================
  Local Access:      ${url}
  ${tailscale ? `Tailscale / Remote: http://${tailscale.address}:${port}` : ''}
  
  Features:
  • Real-time Quota Gauges (Antigravity & Codex)
  • 1-Click Profile Hot Swapping
  • Scoped Account Handoff (Export & Import)
  • Native Agent Launch & Stop Control
  • System Diagnostics & Doctor

  Press Ctrl+C to shut down the web server.
================================================================
`);

  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => resolve());
    process.on('SIGTERM', () => resolve());
  });

  console.log('\nShutting down web server...');
  await close();
  process.exit(0);
}
