import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { chmod, open, rm, lstat } from 'node:fs/promises';
import { z } from 'zod';
import { redact } from '../util.js';
import { environment, initManagementPaths, managementPaths } from './paths.js';
import { ManagementStore } from './store.js';
import { ManagementService } from './service.js';
import { closeCopilotObservers } from './copilot.js';
import { closeCodexObservers } from './codex.js';

process.umask(0o077);
await initManagementPaths();
const lock = await open(managementPaths.lock, 'a', 0o600);
await new Promise<void>((resolve, reject) => {
  const child = spawn('flock', ['--nonblock', '3'], {
    stdio: ['ignore', 'ignore', 'ignore', lock.fd],
  });
  child.once('error', reject);
  child.once('exit', (code) =>
    code === 0 ? resolve() : reject(new Error('Management daemon is already running')),
  );
});
const store = new ManagementStore(managementPaths.db);
const service = new ManagementService(store, await environment());
await service.initialize();
try {
  const existing = await lstat(managementPaths.socket);
  if (!existing.isSocket() || existing.uid !== process.getuid?.())
    throw new Error('Refusing to replace an unsafe socket path');
  await rm(managementPaths.socket);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const Request = z.object({
  protocolVersion: z.literal(1),
  method: z.string().min(1).max(80),
  params: z.unknown().optional(),
});
const server = createServer((socket) => {
  const controller = new AbortController();
  socket.on('close', () => controller.abort());
  let body = '';
  let handled = false;
  socket.setTimeout(120_000, () => socket.destroy());
  socket.on('error', () => {});
  socket.on('data', async (chunk) => {
    if (handled) return;
    body += chunk.toString();
    if (Buffer.byteLength(body) > 128 * 1024) {
      handled = true;
      socket.end(JSON.stringify({ protocolVersion: 1, error: 'Request exceeds limit' }) + '\n');
      return;
    }
    const end = body.indexOf('\n');
    if (end < 0) return;
    handled = true;
    try {
      const request = Request.parse(JSON.parse(body.slice(0, end)));
      const result = await service.rpc(request.method, request.params ?? {}, controller.signal);
      socket.end(JSON.stringify({ protocolVersion: 1, result }) + '\n');
    } catch (error) {
      socket.end(
        JSON.stringify({ protocolVersion: 1, error: redact((error as Error).message) }) + '\n',
      );
    }
  });
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(managementPaths.socket, resolve);
});
await chmod(managementPaths.socket, 0o600);
console.log('Principal management ready');
const timer = setInterval(() => {
  void service
    .tick()
    .catch(() => console.error('Management reconciliation failed; observations will be retried'));
}, 4000);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  server.close();
  closeCodexObservers();
  closeCopilotObservers();
  // Native invocations are independent; stopping management never signals them.
  await rm(managementPaths.socket, { force: true });
  await lock.close();
  store.close();
  process.exit(0);
}
process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
