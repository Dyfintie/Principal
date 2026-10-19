import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, initPaths, sleep } from './util.js';
function send(method: string, args: unknown, timeout = 0) {
  return new Promise<any>((resolve, reject) => {
    const req = request(
      {
        socketPath: paths.socket,
        path: '/rpc',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (b) => chunks.push(b));
        response.on('end', () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString());
            payload.error ? reject(new Error(payload.error)) : resolve(payload.result);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    if (timeout)
      req.setTimeout(timeout, () => {
        const error = Object.assign(new Error('Existing usage service timed out'), {
          code: 'ETIMEDOUT',
        });
        req.destroy(error);
      });
    req.on('error', reject);
    req.end(JSON.stringify({ method, args, protocolVersion: 2 }));
  });
}
/** Management reads must never start the execution coordinator or refresh its runtimes. */
export function existingUsage() {
  return send('usage', { refresh: false }, 5000);
}
let ready: Promise<void> | null = null;
let negotiated: Promise<void> | null = null;
async function start() {
  await initPaths();
  try {
    await send('accounts.list', {});
    return;
  } catch (e) {
    if (!['ENOENT', 'ECONNREFUSED'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
  }
  const log = await open(path.join(paths.state, 'daemon.log'), 'a', 0o600);
  const daemon = path.join(path.dirname(fileURLToPath(import.meta.url)), 'daemon.js');
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
  await log.close();
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    try {
      await send('accounts.list', {});
      return;
    } catch {}
  }
  throw new Error(`Coordinator failed to start. Read ${paths.state}/daemon.log`);
}
export function resetConnection() {
  ready = null;
  negotiated = null;
}
export async function rpc(method: string, args: unknown = {}) {
  ready ??= start().catch((error) => {
    ready = null;
    throw error;
  });
  await ready;
  if (method.startsWith('sessions.')) {
    negotiated ??= send('protocol', {})
      .then((p) => {
        if (!p.supported?.includes(2) || !p.sessions)
          throw new Error(
            'Daemon does not support session protocol 2; restart the coordinator after active work settles',
          );
      })
      .catch((e) => {
        negotiated = null;
        throw new Error(`Session protocol negotiation failed: ${e.message}`);
      });
    await negotiated;
  }
  try {
    return await send(method, args);
  } catch (error) {
    if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      ready = null;
      negotiated = null;
    }
    throw error;
  }
}
