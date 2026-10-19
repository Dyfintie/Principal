#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distPackageDir = path.join(rootDir, 'dist-package');

// 1. Ensure packages are built
if (!fs.existsSync(path.join(distPackageDir, 'principal-linux-x64.tar.gz'))) {
  console.log('Building Principal packages first...');
  execFileSync(process.execPath, [path.join(rootDir, 'scripts', 'package.mjs')], {
    cwd: rootDir,
    stdio: 'inherit',
  });
}

const PORT = parseInt(process.env.PORT || '8088', 10);

// 2. Discover available network IPs
function getNetworkAddresses() {
  const ifaces = os.networkInterfaces();
  const addresses = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const info of list) {
      if (info.family === 'IPv4' && !info.internal) {
        addresses.push({ name, address: info.address });
      }
    }
  }
  return addresses;
}

const addresses = getNetworkAddresses();

// 3. HTTP Server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // Serve install.sh dynamically configured for the requester's host
  if (pathname === '/install.sh' || pathname === '/install') {
    try {
      const host = req.headers.host || `localhost:${PORT}`;
      const installSh = await readFile(path.join(rootDir, 'install.sh'), 'utf8');
      const customized = installSh.replace(
        'DEFAULT_BASE_URL=""',
        `DEFAULT_BASE_URL="http://${host}"`,
      );
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(customized);
      console.log(`[HTTP] Served dynamic install.sh to ${req.socket.remoteAddress} (host: ${host})`);
      return;
    } catch (err) {
      res.writeHead(500).end(`Failed to load install.sh: ${err.message}`);
      return;
    }
  }

  // Serve static files in dist-package/
  const cleanPath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  const candidateFile = path.join(distPackageDir, path.basename(cleanPath));

  if (fs.existsSync(candidateFile) && fs.statSync(candidateFile).isFile()) {
    const ext = path.extname(candidateFile);
    const contentType =
      ext === '.gz' || ext === '.tgz'
        ? 'application/gzip'
        : ext === '.sh'
          ? 'text/x-shellscript; charset=utf-8'
          : 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': fs.statSync(candidateFile).size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(candidateFile).pipe(res);
    console.log(`[HTTP] Served ${path.basename(candidateFile)} to ${req.socket.remoteAddress}`);
    return;
  }

  // Browser Landing Page
  if (pathname === '/') {
    const primaryIp =
      addresses.find((a) => a.name.includes('tailscale'))?.address ||
      addresses[0]?.address ||
      'localhost';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Principal CLI Distribution Server</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; background: #0d1117; color: #c9d1d9; }
    h1 { color: #58a6ff; }
    code, pre { background: #161b22; padding: 12px; border-radius: 6px; display: block; overflow-x: auto; font-size: 14px; color: #79c0ff; border: 1px solid #30363d; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .badge { background: #238636; color: white; padding: 2px 8px; border-radius: 12px; font-size: 12px; }
  </style>
</head>
<body>
  <h1>⚡ Principal CLI <span class="badge">v0.1.0</span></h1>
  <p>Local management for native coding-agent profiles, sessions, and shared quota.</p>
  
  <h3>🚀 One-Liner Install (Antigravity Feel)</h3>
  <pre>curl -fsSL http://${primaryIp}:${PORT}/install.sh | bash</pre>
  
  <h3>📦 Standalone Downloads</h3>
  <ul>
    <li><a href="/install.sh">install.sh</a> (Web installer)</li>
    <li><a href="/principal-installer.sh">principal-installer.sh</a> (Self-extracting script)</li>
    <li><a href="/principal-linux-x64.tar.gz">principal-linux-x64.tar.gz</a> (Pre-compiled bundle)</li>
    <li><a href="/principal-cli-0.1.0.tgz">principal-cli-0.1.0.tgz</a> (NPM global package)</li>
  </ul>
</body>
</html>`);
    return;
  }

  res.writeHead(404).end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n================================================================');
  console.log('🚀 Principal Distribution Server Running!');
  console.log('================================================================');
  console.log('Anyone on your network can install Principal with ONE command:\n');

  const ts = addresses.find((a) => a.name.includes('tailscale'));
  if (ts) {
    console.log(`  • Over Tailscale (Phone, Laptop, Remote):`);
    console.log(`    curl -fsSL http://${ts.address}:${PORT}/install.sh | bash\n`);
  }

  for (const iface of addresses) {
    if (!iface.name.includes('tailscale')) {
      console.log(`  • Over Local Network (${iface.name}):`);
      console.log(`    curl -fsSL http://${iface.address}:${PORT}/install.sh | bash\n`);
    }
  }

  console.log(`  • Localhost test:`);
  console.log(`    curl -fsSL http://127.0.0.1:${PORT}/install.sh | bash\n`);
  console.log('Press Ctrl+C to stop the server.');
  console.log('================================================================\n');
});
