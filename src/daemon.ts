import { spawn } from 'node:child_process';
import path from 'node:path';
import { createServer } from 'node:http';
import { rm, chmod, open } from 'node:fs/promises';
import { Coordinator } from './coordinator.js';
import { initPaths, paths, redact } from './util.js';
process.umask(0o077);
await initPaths();
// flock operates on the inherited open file description, retained by this process.
// Closing the short-lived flock subprocess does not close our lifetime lock handle.
const daemonLock = await open(path.join(paths.state, 'daemon.lock'), 'a', 0o600);
await new Promise<void>((resolve, reject) => {
  const child = spawn('flock', ['--nonblock', '3'], {
    stdio: ['ignore', 'inherit', 'inherit', daemonLock.fd],
  });
  child.once('error', reject);
  child.once('exit', (code) =>
    code === 0 ? resolve() : reject(new Error('Principal coordinator is already running')),
  );
});
const coordinator = new Coordinator();
await coordinator.startup();
await rm(paths.socket, { force: true });
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/rpc') {
    response.writeHead(404);
    response.end();
    return;
  }
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error('Request exceeds 1 MiB');
      chunks.push(chunk);
    }
    const { method, args, protocolVersion } = JSON.parse(Buffer.concat(chunks).toString());
    if (protocolVersion !== undefined && ![1, 2].includes(protocolVersion))
      throw new Error('Unsupported CLI/daemon protocol version');
    if (method.startsWith('sessions.') && protocolVersion !== 2)
      throw new Error('Sessions require protocol version 2');
    const result = await coordinator.rpc(method, args ?? {});
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({ schemaVersion: 1, protocolVersion: protocolVersion ?? 1, result }),
    );
  } catch (e) {
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ schemaVersion: 1, error: redact((e as Error).message) }));
  }
});
server.listen(paths.socket, async () => {
  await chmod(paths.socket, 0o600);
  console.log('Principal coordinator ready');
});
const timer = setInterval(
  () => coordinator.tick().catch((e) => console.error(redact((e as Error).message))),
  1000,
);
async function shutdown() {
  clearInterval(timer);
  server.close();
  coordinator.store.close();
  await rm(paths.socket, { force: true });
  await daemonLock.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
