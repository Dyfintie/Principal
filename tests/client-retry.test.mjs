import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
test('RPC retries after a rejected startup promise', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'principal-client-'));
  process.env.XDG_STATE_HOME = directory;
  const state = path.join(directory, 'principal');
  await mkdir(state);
  let first = true;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.end(JSON.stringify(first ? { error: 'temporary fixture failure' } : { result: 'ok' }));
    first = false;
  });
  await new Promise((resolve) => server.listen(path.join(state, 'daemon.sock'), resolve));
  try {
    const { rpc } = await import('../dist/client.js');
    await assert.rejects(rpc('fixture'), /temporary/);
    assert.equal(await rpc('fixture'), 'ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
