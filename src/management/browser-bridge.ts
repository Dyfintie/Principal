import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function allowedLoginUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x20\x7f]/.test(value))
    return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      ['accounts.google.com', 'antigravity.google'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
/** Only browser launch crosses the boundary. The agent's Secret Service stays private. */
export async function startBrowserBridge(runtime: string, opener: string, hostEnv = process.env) {
  const socketPath = path.join(runtime, 'browser.sock');
  const clients = new Set<import('node:net').Socket>();
  let lastWindow = 0,
    count = 0;
  const server = createServer((socket) => {
    clients.add(socket);
    socket.once('close', () => clients.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(5000, () => socket.destroy());
    let body = '',
      handled = false;
    socket.on('data', (chunk) => {
      if (handled) return;
      body += chunk.toString();
      if (Buffer.byteLength(body) > 20000) {
        socket.destroy();
        return;
      }
      if (!body.includes('\n')) return;
      handled = true;
      let url: unknown;
      try {
        url = JSON.parse(body.slice(0, body.indexOf('\n'))).url;
      } catch {}
      if (Date.now() - lastWindow > 60000) {
        lastWindow = Date.now();
        count = 0;
      }
      if (!allowedLoginUrl(url) || ++count > 5) {
        socket.end('{"ok":false}\n');
        return;
      }
      const child = spawn(opener, [url], { env: hostEnv, stdio: 'ignore' });
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        socket.end('{"ok":false}\n');
      }, 4000);
      child.once('error', () => {
        clearTimeout(timeout);
        socket.end('{"ok":false}\n');
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        socket.end(JSON.stringify({ ok: code === 0 }) + '\n');
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  const bin = path.join(runtime, 'browser-bin');
  await mkdir(bin, { mode: 0o700 });
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  await writeFile(
    path.join(bin, 'xdg-open'),
    '#!/bin/sh\nexec ' +
      quote(process.execPath) +
      ' ' +
      quote(fileURLToPath(new URL('./browser-open.js', import.meta.url))) +
      ' "$@"\n',
    { mode: 0o700 },
  );
  return {
    bin,
    socket: socketPath,
    close: async () => {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socketPath, { force: true });
    },
  };
}
