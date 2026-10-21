import path from 'node:path';
import { createConnection } from 'node:net';
import { open, lstat, readFile } from 'node:fs/promises';
import type { WorkerRecord, WorkerRuntime } from './worker-model.js';

export const runtimeFile = (record: WorkerRecord) => path.join(record.directory, 'runtime.json');
export async function readWorkerRuntime(record: WorkerRecord): Promise<WorkerRuntime | null> {
  try { return JSON.parse(await readFile(runtimeFile(record), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function workerCommand(record: WorkerRecord, method: string, params: unknown, timeout = 10_000): Promise<any> {
  const metadata = await lstat(record.socket);
  if (!metadata.isSocket() || metadata.uid !== process.getuid?.() || metadata.mode & 0o077) throw new Error('Unsafe worker control socket');
  return new Promise((resolve, reject) => {
    const socket = createConnection(record.socket);
    let buffer = '';
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true; socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.setTimeout(timeout, () => finish(new Error('Worker control timed out; inspect its state before retrying with the same request_id')));
    socket.on('error', (error) => finish(error));
    socket.on('connect', () => socket.write(JSON.stringify({ method, params }) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 128 * 1024) return finish(new Error('Worker control response exceeds limit'));
      if (!buffer.includes('\n')) return;
      try {
        const value = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
        finish(value.error ? new Error(value.error) : undefined, value.result);
      } catch (error) { finish(error as Error); }
    });
    socket.on('end', () => finish(new Error('Worker disconnected before acknowledging the command')));
  });
}

export async function readWorkerEvents(record: WorkerRecord, cursor: number) {
  const handle = await open(path.join(record.directory, 'events.jsonl'), 'r').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!handle) return { events: [], nextCursor: 0, hasMore: false };
  try {
    const size = (await handle.stat()).size;
    if (cursor > size) throw new Error('Event cursor is beyond the journal');
    if (cursor > 0) {
      const previous = Buffer.alloc(1);
      await handle.read(previous, 0, 1, cursor - 1);
      if (previous[0] !== 10) throw new Error('Event cursor must be returned by principal_get_worker');
    }
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor);
    const text = buffer.subarray(0, bytesRead);
    const end = text.lastIndexOf(10);
    if (end < 0) return { events: [], nextCursor: cursor, hasMore: cursor < size };
    const events = text.subarray(0, end).toString().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { events, nextCursor: cursor + end + 1, hasMore: cursor + end + 1 < size };
  } finally { await handle.close(); }
}
