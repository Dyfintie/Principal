import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { open, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initManagementPaths, managementPaths } from './paths.js';
import { sleep } from '../util.js';

export async function sendManagement(
  method: string,
  params: unknown = {},
  timeout = 35_000,
  socketPath = managementPaths.socket,
): Promise<any> {
  if (!path.isAbsolute(socketPath)) throw new Error('Management socket must be absolute');
  const metadata = await lstat(socketPath);
  if (!metadata.isSocket() || metadata.uid !== process.getuid?.() || metadata.mode & 0o077)
    throw new Error('Unsafe management socket permissions');
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let body = '';
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.setTimeout(timeout, () => finish(new Error('Management request timed out')));
    socket.on('error', (error) => finish(error));
    socket.on('connect', () =>
      socket.write(JSON.stringify({ protocolVersion: 1, method, params }) + '\n'),
    );
    socket.on('data', (chunk) => {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 16 * 1024 * 1024) {
        finish(new Error('Management response exceeds limit'));
        return;
      }
      const end = body.indexOf('\n');
      if (end < 0) return;
      try {
        const payload = JSON.parse(body.slice(0, end));
        if (payload.protocolVersion !== 1) throw new Error('Unsupported management protocol');
        payload.error ? finish(new Error(payload.error)) : finish(undefined, payload.result);
      } catch (error) {
        finish(error as Error);
      }
    });
    socket.on('end', () => finish(new Error('Management connection closed without a response')));
  });
}
let ready: Promise<void> | null = null;
async function startManager() {
  await initManagementPaths();
  try {
    await sendManagement('snapshot');
    return;
  } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw error;
  }
  const log = await open(path.join(managementPaths.state, 'manager.log'), 'a', 0o600);
  try {
    const daemon = fileURLToPath(new URL('./daemon.js', import.meta.url));
    const child = spawn(process.execPath, [daemon], {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: process.env,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  } finally {
    await log.close();
  }
  for (let attempt = 0; attempt < 150; attempt++) {
    await sleep(100);
    try {
      await sendManagement('snapshot');
      return;
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error;
    }
  }
  throw new Error(
    `Management daemon could not start; inspect ${managementPaths.state}/manager.log`,
  );
}
export async function managementRpc(method: string, params: unknown = {}, timeout = 35_000) {
  ready ??= startManager().catch((error) => {
    ready = null;
    throw error;
  });
  await ready;
  try {
    return await sendManagement(method, params, timeout);
  } catch (error) {
    if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      ready = null;
      // Retry reads only. Never replay a potentially completed mutation.
      if (
        ['snapshot', 'events', 'profiles.list', 'resources', 'invocations.control'].includes(method)
      ) {
        ready = startManager().catch((e) => {
          ready = null;
          throw e;
        });
        await ready;
        return sendManagement(method, params, timeout);
      }
    }
    throw error;
  }
}
