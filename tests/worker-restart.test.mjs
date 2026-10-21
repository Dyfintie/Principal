import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManagementStore } from '../dist/management/store.js';
import { sendManagement } from '../dist/management/client.js';
import { exec, sleep } from '../dist/util.js';
import { identityMatches } from '../dist/management/process.js';

test('real daemon restart and MCP disconnection preserve a controlled worker and its exact profile', { timeout: 45000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'principal-restart-'));
  const home = path.join(root, 'home'), binaries = path.join(root, 'bin');
  const state = path.join(root, 's', 'principal', 'management'), runtime = path.join(root, 'r');
  for (const directory of [home, binaries, state, runtime]) await mkdir(directory, { recursive: true });
  const provider = '#!' + process.execPath + '\n' + (await readFile(new URL('./fixtures/controlled-provider.mjs', import.meta.url), 'utf8')).split('\n').slice(1).join('\n');
  await writeFile(path.join(binaries, 'codex'), provider, { mode: 0o700 });
  const profileId = randomUUID(), profileDirectory = path.join(home, '.codex');
  await mkdir(profileDirectory);
  const store = new ManagementStore(path.join(state, 'manager.sqlite'));
  store.put('profile', { id: profileId, tool: 'codex', label: 'restart-fixture', directory: profileDirectory, isolated: false, createdAt: new Date().toISOString(), auth: 'authenticated', reportedAccount: null });
  store.close();
  const repo = path.join(root, 'repo'); await mkdir(repo);
  await exec('git', ['init', '-q'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'fixture'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repo });
  await writeFile(path.join(repo, 'base.txt'), 'baseline');
  await exec('git', ['add', '.'], { cwd: repo }); await exec('git', ['commit', '-qm', 'baseline'], { cwd: repo });
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: path.join(root, 's'), XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), PATH: binaries + ':' + path.dirname(process.execPath) + ':/usr/bin:/bin' };
  for (const key of ['CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_AUTH_JSON']) delete env[key];
  const socket = path.join(runtime, 'principal-management', 'manager.sock');
  const rpc = (method, params = {}) => sendManagement(method, params, 10000, socket);
  let daemon, mcp, workerId;
  const exit = async (child) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const stopped = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM'); await stopped;
  };
  t.after(async () => {
    if (workerId && daemon?.exitCode === null) {
      await rpc('workers.cancel', { worker_id: workerId, request_id: randomUUID() }).catch(() => {});
      for (let i = 0; i < 100; i++) {
        const state = await rpc('workers.get', { worker_id: workerId }).catch(() => null);
        if (state && !state.reserved) break;
        await sleep(50);
      }
    }
    await exit(mcp); await exit(daemon); await rm(root, { recursive: true, force: true });
  });
  async function startDaemon() {
    daemon = spawn(process.execPath, [fileURLToPath(new URL('../dist/management/daemon.js', import.meta.url))], { env, stdio: 'ignore' });
    for (let i = 0; i < 150; i++) {
      if (daemon.exitCode !== null) assert.fail('Fixture daemon failed to start');
      try { await rpc('workers.list'); return; } catch {}
      await sleep(50);
    }
    assert.fail('Fixture daemon did not listen');
  }
  async function until(predicate) {
    for (let i = 0; i < 200; i++) { const state = await rpc('workers.get', { worker_id: workerId }); if (predicate(state)) return state; await sleep(40); }
    assert.fail('Worker state did not converge');
  }
  await startDaemon();
  const created = await rpc('workers.start', { request_id: 'restart-start', profile_id: profileId, cwd: repo, task: 'hang' });
  workerId = created.workerId;
  const before = await until((s) => s.lifecycle === 'running' && s.turn?.providerTurnId);
  mcp = spawn(process.execPath, [fileURLToPath(new URL('../bin/principal-mcp.mjs', import.meta.url))], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const responses = new Map();
  createInterface({ input: mcp.stdout }).on('line', (line) => { const value = JSON.parse(line); responses.set(value.id, value); });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'principal_get_worker', arguments: { worker_id: workerId } } }) + '\n');
  for (let i = 0; i < 100 && !responses.has(1); i++) await sleep(20);
  assert.ok(responses.has(1));
  assert.equal(JSON.parse(responses.get(1).result.content[0].text).workerId, workerId);
  await exit(mcp);
  assert.equal(await identityMatches(before.runner), true);
  await exit(daemon);
  assert.equal(await identityMatches(before.native), true);
  await startDaemon();
  const after = await rpc('workers.get', { worker_id: workerId });
  assert.equal(after.profileId, profileId);
  assert.deepEqual(after.runner, before.runner);
  assert.deepEqual(after.native, before.native);
  await assert.rejects(rpc('workers.start', { request_id: 'competing', profile_id: profileId, cwd: repo, task: 'must not run' }), /reserved/);
  await rpc('workers.message', { request_id: 'steer-after-restart', worker_id: workerId, message: 'finished', delivery: 'steer', expected_turn_id: after.turn.providerTurnId });
  const completed = await until((s) => s.lifecycle === 'ready' && s.turn?.artifacts);
  assert.equal(completed.turn.status, 'completed');
  await rpc('workers.cancel', { worker_id: workerId, request_id: 'stop-after-restart' });
  await until((s) => s.lifecycle === 'stopped' && !s.reserved);
  await rpc('workers.release', { worker_id: workerId, request_id: 'release-after-restart' });
});
