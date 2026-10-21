import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const root = await mkdtemp(path.join(tmpdir(), 'principal-w-'));
process.env.XDG_STATE_HOME = path.join(root, 'state');
process.env.XDG_RUNTIME_DIR = path.join(root, 'r');
await mkdir(process.env.XDG_RUNTIME_DIR);
const { initManagementPaths } = await import('../dist/management/paths.js');
await initManagementPaths();
const { ManagementStore } = await import('../dist/management/store.js');
const { WorkerManager } = await import('../dist/management/workers.js');
const { defaultDirectory } = await import('../dist/management/providers.js');
const { inspectWorkerCapabilities } = await import('../dist/management/worker-provider.js');
const { captureWorkerWorkspace, createWorkerWorkspace, releaseWorkerWorkspace } = await import('../dist/management/worker-workspace.js');
const { exec, sleep } = await import('../dist/util.js');
const { identityMatches, processIdentity, forceStopOwned } = await import('../dist/management/process.js');
const fixture = path.join(root, 'provider');
await writeFile(fixture, '#!' + process.execPath + '\n' + (await readFile(new URL('./fixtures/controlled-provider.mjs', import.meta.url), 'utf8')).split('\n').slice(1).join('\n'), { mode: 0o700 });
const installations = ['codex', 'antigravity', 'claude', 'copilot'].map((tool) => ({ tool, executable: fixture, version: '0.163.0', verifiedVersion: true, checkedAt: 'fixture', capabilities: {} }));
const stores = [];
test('native capability inspection accepts successful help on stderr', async () => {
  const stderrFixture = fixture + '-stderr';
  await writeFile(stderrFixture, await readFile(fixture), { mode: 0o700 });
  const capabilities = await inspectWorkerCapabilities({ ...installations[1], executable: stderrFixture });
  assert.equal(capabilities.execution, true);
  assert.equal(capabilities.stream, true);
  assert.equal(capabilities.resume, true);
  assert.equal(capabilities.model, true);
  assert.ok(capabilities.effort.includes('max'));
});
async function context() {
  const directory = path.join(root, randomUUID());
  await mkdir(directory);
  await exec('git', ['init', '-q'], { cwd: directory });
  await exec('git', ['config', 'user.name', 'fixture'], { cwd: directory });
  await exec('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: directory });
  await writeFile(path.join(directory, 'base.txt'), 'original\n');
  await exec('git', ['add', '.'], { cwd: directory });
  await exec('git', ['commit', '-qm', 'baseline'], { cwd: directory });
  const file = path.join(root, randomUUID() + '.sqlite');
  const store = new ManagementStore(file);
  const manager = new WorkerManager(store, () => installations);
  stores.push({ store, manager });
  const profile = async (tool = 'codex') => {
    const id = randomUUID();
    const home = path.join(root, 'p-' + id); await mkdir(home);
    store.put('profile', { id, tool, label: 'fixture-' + id.slice(0, 5), directory: tool === 'copilot' ? defaultDirectory('copilot') : home, isolated: false, createdAt: new Date().toISOString(), auth: 'authenticated', reportedAccount: null });
    return id;
  };
  const start = async (profileId, task = 'work', extra = {}) => manager.start({ request_id: randomUUID(), profile_id: profileId, cwd: directory, task, ...extra });
  return { store, manager, profile, directory, start, file };
}
async function until(manager, workerId, predicate, timeout = 12000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    value = await manager.get({ worker_id: workerId });
    if (predicate(value)) return value;
    await sleep(40);
  }
  assert.fail('Worker did not reach expected state: ' + JSON.stringify(value));
}
async function stop(manager, id) {
  await manager.cancel({ worker_id: id, request_id: randomUUID() });
  return until(manager, id, (s) => s.lifecycle === 'stopped' && !s.reserved);
}
test.after(async () => {
  for (const { store, manager } of stores) {
    for (const worker of await manager.list()) {
      if (!worker.reserved) continue;
      await manager.cancel({ worker_id: worker.workerId, request_id: randomUUID() }).catch(() => {});
      await until(manager, worker.workerId, (s) => !s.reserved, 8000).catch(() => {});
    }
    store.close();
  }
  await rm(root, { recursive: true, force: true });
});

test('exact profile dispatch, global reservation, and request deduplication survive a new manager', async () => {
  const c = await context();
  const profileId = await c.profile();
  const options = { request_id: 'start-once', profile_id: profileId, cwd: c.directory, task: 'first' };
  const [one, two] = await Promise.all([c.manager.start(options), c.manager.start(options)]);
  assert.equal(one.workerId, two.workerId);
  await assert.rejects(c.manager.start({ ...options, task: 'changed' }), /request_id/);
  const state = await until(c.manager, one.workerId, (s) => s.lifecycle === 'ready' && s.turn?.artifacts);
  assert.equal(state.profileId, profileId);
  assert.equal(state.turn.status, 'completed');
  assert.equal(state.nativeSessionId, 'codex-fixture-session');
  const next = new WorkerManager(c.store, () => installations);
  assert.equal((await next.start(options)).workerId, one.workerId);
  await assert.rejects(next.start({ ...options, request_id: 'other' }), /reserved/);
  assert.equal((await next.list()).length, 1);
  const message = { worker_id: one.workerId, request_id: 'follow-once', message: 'second', delivery: 'next_turn' };
  await next.message(message); await next.message(message);
  const done = await until(next, one.workerId, (s) => s.turn?.number === 2 && s.lifecycle === 'ready' && s.turn.artifacts);
  assert.equal((await readFile(path.join(done.workspace.worktreeDir, 'received.txt'), 'utf8')), 'first\nsecond\n');
  const artifact = await next.artifact({ worker_id: one.workerId, artifact_id: 'turn-2.patch' });
  assert.match(Buffer.from(artifact.data, 'base64').toString(), /second/);
  await assert.rejects(next.release({ worker_id: one.workerId, request_id: 'early-release' }), /Stop/);
  await stop(next, one.workerId);
  await next.release({ worker_id: one.workerId, request_id: 'release' });
  await assert.rejects(stat(done.workspace.worktreeDir), { code: 'ENOENT' });
  assert.equal((await next.get({ worker_id: one.workerId })).lifecycle, 'released');
  assert.ok((await next.artifact({ worker_id: one.workerId, artifact_id: 'final.patch' })).size > 0);
});

test('simultaneous clients cannot reserve the same profile', async () => {
  const c = await context(); const profileId = await c.profile();
  const otherStore = new ManagementStore(c.file);
  const other = new WorkerManager(otherStore, () => installations);
  const options = { profile_id: profileId, cwd: c.directory, task: 'hang' };
  const results = await Promise.allSettled([c.manager.start({ ...options, request_id: 'client-one' }), other.start({ ...options, request_id: 'client-two' })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /reserved/);
  otherStore.close();
});

test('Codex steering checks the active turn and does not create an extra turn', async () => {
  const c = await context(); const worker = await c.start(await c.profile(), 'hang');
  const running = await until(c.manager, worker.workerId, (s) => s.turn?.providerTurnId);
  await assert.rejects(c.manager.message({ worker_id: worker.workerId, request_id: 'bad-steer', message: 'fix', delivery: 'steer', expected_turn_id: 'wrong' }), /expected_turn_id|active/i);
  const response = await c.manager.message({ worker_id: worker.workerId, request_id: 'steer', message: 'corrected', delivery: 'auto', expected_turn_id: running.turn.providerTurnId });
  assert.equal(response.delivery, 'steer');
  const done = await until(c.manager, worker.workerId, (s) => s.lifecycle === 'ready' && s.turn?.artifacts);
  assert.equal(done.turn.number, 1);
  assert.match(await readFile(path.join(done.workspace.worktreeDir, 'answer.txt'), 'utf8'), /corrected/);
});

test('Antigravity queues follow-ups, pauses them after failure, and never silently steers', async () => {
  const c = await context(); const worker = await c.start(await c.profile('antigravity'), 'hang');
  await until(c.manager, worker.workerId, (s) => s.lifecycle === 'running' && s.nativeSessionId);
  await assert.rejects(c.manager.message({ worker_id: worker.workerId, request_id: 'no-steer', message: 'fix', delivery: 'steer' }), /steering/);
  const queued = await c.manager.message({ worker_id: worker.workerId, request_id: 'queue', message: 'second' });
  assert.equal(queued.delivery, 'next_turn');
  assert.equal((await c.manager.get({ worker_id: worker.workerId })).queuedMessages, 1);
  const stopped = await stop(c.manager, worker.workerId);
  assert.equal(stopped.turn.status, 'cancelled');
  await c.manager.resume({ worker_id: worker.workerId, request_id: 'resume' });
  const ready = await until(c.manager, worker.workerId, (s) => s.lifecycle === 'ready');
  assert.equal(ready.nativeSessionId, stopped.nativeSessionId);
  assert.equal(ready.queuedMessages, 1);
  await sleep(100);
  assert.equal((await c.manager.get({ worker_id: worker.workerId })).turn.number, 1);
  await c.manager.message({ worker_id: worker.workerId, request_id: 'continue-queue', message: 'third', delivery: 'next_turn' });
  const done = await until(c.manager, worker.workerId, (s) => s.turn?.number === 3 && s.lifecycle === 'ready' && s.turn.artifacts);
  assert.equal(await readFile(path.join(done.workspace.worktreeDir, 'received.txt'), 'utf8'), 'hang\nsecond\nthird\n');
});

test('CSES failure pattern: one immediate failure and two silent workers stay individually cancellable', async () => {
  const c = await context();
  const failing = await c.start(await c.profile('antigravity'), 'fail');
  const hangs = await Promise.all([c.start(await c.profile('antigravity'), 'hang', { timeout_seconds: 5 }), c.start(await c.profile('antigravity'), 'hang', { timeout_seconds: 5 })]);
  const failed = await until(c.manager, failing.workerId, (s) => s.lifecycle === 'stopped' && !s.reserved);
  assert.equal(failed.turn.status, 'failed');
  assert.equal(failed.turn.error.category, 'authentication');
  const events = JSON.stringify((await c.manager.get({ worker_id: failing.workerId })).events);
  assert.ok(!events.includes('private-token-must-not-persist'));
  await until(c.manager, hangs[0].workerId, (s) => s.lifecycle === 'running');
  const waiting = c.manager.get({ worker_id: hangs[0].workerId, cursor: (await c.manager.get({ worker_id: hangs[0].workerId })).nextCursor, wait_seconds: 2 });
  await stop(c.manager, hangs[0].workerId);
  await waiting;
  const timedOut = await until(c.manager, hangs[1].workerId, (s) => s.lifecycle === 'stopped' && !s.reserved);
  assert.equal(timedOut.turn.status, 'timeout');
  assert.equal((await c.manager.list()).length, 3);
});

test('zero exit without a provider result and malformed output cannot become success', async () => {
  const c = await context();
  for (const task of ['exit-zero', 'malformed']) {
    const worker = await c.start(await c.profile(), task);
    const state = await until(c.manager, worker.workerId, (s) => s.lifecycle === 'stopped' && !s.reserved);
    assert.notEqual(state.turn.status, 'completed');
    assert.ok(state.turn.artifacts);
  }
});

test('cancellation kills an owned resistant descendant and leaves an unrelated process alone', async () => {
  const c = await context(); const worker = await c.start(await c.profile(), 'spawn-hang');
  const active = await until(c.manager, worker.workerId, (s) => s.lifecycle === 'running' && s.native);
  let pid;
  for (let i = 0; i < 100 && !pid; i++) { pid = await readFile(path.join(active.workspace.worktreeDir, 'descendant.pid'), 'utf8').then(Number).catch(() => null); if (!pid) await sleep(20); }
  const { processIdentity } = await import('../dist/management/process.js');
  const identity = await processIdentity(pid);
  assert.ok(identity);
  await stop(c.manager, worker.workerId);
  assert.equal(await identityMatches(identity), false);
  assert.equal(await identityMatches(await processIdentity(process.pid)), true);
});

test('runner loss keeps ownership uncertain until explicit cancellation recovers the native process', async () => {
  const c = await context(); const worker = await c.start(await c.profile(), 'hang');
  const active = await until(c.manager, worker.workerId, (s) => s.lifecycle === 'running' && s.native);
  await forceStopOwned(active.runner, await processIdentity(process.pid));
  const interrupted = await until(c.manager, worker.workerId, (s) => s.lifecycle === 'interrupted');
  assert.equal(interrupted.reserved, true);
  assert.equal(interrupted.cleanupRequired, true);
  assert.equal(await identityMatches(active.native), true);
  assert.equal((await c.manager.list()).length, 1);
  if (interrupted.reserved) await c.manager.cancel({ worker_id: worker.workerId, request_id: 'recover' });
  await until(c.manager, worker.workerId, (s) => !s.reserved);
});

test('worktree capture includes commits, deletions, binary and untracked files without changing the real index', async () => {
  const c = await context();
  await writeFile(path.join(c.directory, 'dirty.txt'), 'not in HEAD');
  const workspace = await createWorkerWorkspace(c.directory, randomUUID());
  assert.equal(workspace.sourceDirty, true);
  await assert.rejects(stat(path.join(workspace.worktreeDir, 'dirty.txt')), { code: 'ENOENT' });
  const cwd = { cwd: workspace.worktreeDir };
  await rm(path.join(workspace.worktreeDir, 'base.txt'));
  await writeFile(path.join(workspace.worktreeDir, 'committed.txt'), 'worker commit');
  await exec('git', ['add', '-A'], cwd); await exec('git', ['commit', '-qm', 'worker commit'], cwd);
  await writeFile(path.join(workspace.worktreeDir, 'odd\nname.bin'), Buffer.from([0, 1, 2, 255]));
  await writeFile(path.join(workspace.worktreeDir, 'staged.txt'), 'stage only');
  await exec('git', ['add', 'staged.txt'], cwd);
  const index = (await exec('git', ['ls-files', '--stage', '-z'], cwd)).stdout;
  const snapshot = await captureWorkerWorkspace(workspace);
  assert.deepEqual((await exec('git', ['ls-files', '--stage', '-z'], cwd)).stdout, index);
  assert.ok(snapshot.files.includes('base.txt'));
  assert.ok(snapshot.files.includes('committed.txt'));
  assert.ok(snapshot.files.includes('odd\nname.bin'));
  assert.match(snapshot.diff, /GIT binary patch/);
  await writeFile(path.join(c.directory, 'patch'), snapshot.diff);
  await exec('git', ['apply', '--check', 'patch'], { cwd: c.directory });
  await releaseWorkerWorkspace(workspace);
});

test('explicit batches reject auto, duplicate profiles and hidden queueing; unsupported providers never launch', async () => {
  const c = await context(); const profileId = await c.profile();
  const task = { profile_id: profileId, cwd: c.directory, task: 'work' };
  await assert.rejects(c.manager.deploy({ request_id: 'auto', provider: 'auto', tasks: [task] }));
  await assert.rejects(c.manager.deploy({ request_id: 'dup', tasks: [task, task] }), /different explicit profile/);
  await assert.rejects(c.manager.start({ request_id: 'unsupported', profile_id: await c.profile('claude'), cwd: c.directory, task: 'work' }), /unsupported/);
  assert.equal((await c.manager.list()).length, 0);
  const batch = await c.manager.deploy({ request_id: 'batch', tasks: [task] });
  assert.equal((await c.manager.deploy({ request_id: 'batch', tasks: [task] })).swarmId, batch.swarmId);
  assert.equal(batch.workers.length, 1);
  const workerId = batch.workers[0].workerId;
  await until(c.manager, workerId, (s) => s.lifecycle === 'ready' && s.turn?.artifacts);
  assert.equal((await new WorkerManager(c.store, () => installations).swarmStatus(batch.swarmId)).status, 'completed');
  await c.manager.cancelBatch({ swarm_id: batch.swarmId, request_id: 'stop-batch' });
  await until(c.manager, workerId, (s) => !s.reserved);
});

test('polling during the resume launch window cannot release the new generation reservation', async () => {
  const c = await context(); const profileId = await c.profile();
  const worker = await c.start(profileId, 'first');
  await until(c.manager, worker.workerId, (s) => s.lifecycle === 'ready' && s.turn?.artifacts);
  await stop(c.manager, worker.workerId);
  const original = c.manager.spawn.bind(c.manager);
  let allowSpawn, signalEntered;
  const gate = new Promise((resolve) => { allowSpawn = resolve; });
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  c.manager.spawn = async (spec) => { signalEntered(); await gate; return original(spec); };
  const resuming = c.manager.resume({ worker_id: worker.workerId, request_id: 'resume-window' });
  await entered;
  try {
    const during = await c.manager.get({ worker_id: worker.workerId });
    assert.equal(during.lifecycle, 'starting');
    assert.equal(during.reserved, true);
    await assert.rejects(c.start(profileId, 'must not run'), /reserved/);
  } finally { allowSpawn(); }
  await resuming;
  const resumed = await until(c.manager, worker.workerId, (s) => s.lifecycle === 'ready');
  assert.equal(resumed.reserved, true);
});

test('large deltas are paginated without losing output and result-only responses are retained', async () => {
  const c = await context(); const worker = await c.start(await c.profile(), 'large-output');
  await until(c.manager, worker.workerId, (s) => s.lifecycle === 'ready' && s.turn?.artifacts);
  let cursor = 0, text = '', pages = 0;
  do {
    const page = await c.manager.get({ worker_id: worker.workerId, cursor });
    cursor = page.nextCursor; pages++;
    text += page.events.filter((e) => e.type === 'provider.output').map((e) => e.text).join('');
    if (!page.hasMore) break;
  } while (pages < 20);
  assert.ok(pages > 1);
  assert.equal(text, 'z'.repeat(140000) + 'THE_END');
  const resultOnly = await c.start(await c.profile('antigravity'), 'result-only');
  const done = await until(c.manager, resultOnly.workerId, (s) => s.lifecycle === 'ready' && s.turn?.artifacts);
  assert.equal(done.events.filter((e) => e.type === 'provider.response').map((e) => e.text).join(''), 'A complete final response without deltas.');
});

test('a lost steering acknowledgement cannot block cancellation or cause instruction replay', async () => {
  const c = await context(); const worker = await c.start(await c.profile(), 'hang');
  const running = await until(c.manager, worker.workerId, (s) => s.turn?.providerTurnId);
  const message = { worker_id: worker.workerId, request_id: 'lost-ack', message: 'no-ack', delivery: 'steer', expected_turn_id: running.turn.providerTurnId };
  const waiting = c.manager.message(message).catch((error) => error);
  await sleep(100);
  const before = Date.now();
  await c.manager.cancel({ worker_id: worker.workerId, request_id: 'cancel-during-steer' });
  assert.ok(Date.now() - before < 1000);
  await until(c.manager, worker.workerId, (s) => s.lifecycle === 'stopped' && !s.reserved);
  await waiting;
  const replay = await c.manager.message(message);
  assert.equal(replay.delivery, 'uncertain');
  assert.equal(await readFile(path.join(running.workspace.worktreeDir, 'received.txt'), 'utf8'), 'hang\n');
});

test('failed final artifact capture preserves the stopped workspace until capture succeeds', async () => {
  const c = await context(); const worker = await c.start(await c.profile(), 'work');
  const done = await until(c.manager, worker.workerId, (s) => s.lifecycle === 'ready' && s.turn?.artifacts);
  await stop(c.manager, worker.workerId);
  const sha = done.workspace.baseRevision;
  const object = path.join(c.directory, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
  const saved = await readFile(object);
  await rm(object);
  try {
    await assert.rejects(c.manager.release({ worker_id: worker.workerId, request_id: 'capture-fails' }));
    assert.ok((await stat(done.workspace.worktreeDir)).isDirectory());
    assert.notEqual((await c.manager.get({ worker_id: worker.workerId })).lifecycle, 'released');
  } finally { await writeFile(object, saved); }
  await c.manager.release({ worker_id: worker.workerId, request_id: 'capture-repaired' });
  assert.equal((await c.manager.get({ worker_id: worker.workerId })).lifecycle, 'released');
});


test('Copilot streams native sessions, queues follow-ups, resumes exactly, and retains patches', async () => {
  const c = await context(); const profileId = await c.profile('copilot');
  const capabilities = await inspectWorkerCapabilities(installations.find((i) => i.tool === 'copilot'));
  assert.equal(capabilities.execution, true);
  assert.equal(capabilities.steer, false);
  assert.ok(capabilities.effort.includes('high'));
  const worker = await c.start(profileId, 'hang', { model: 'fixture-model', effort: 'high' });
  const running = await until(c.manager, worker.workerId, (s) => s.lifecycle === 'running' && s.nativeSessionId);
  assert.equal(running.nativeSessionId, worker.workerId);
  await assert.rejects(c.manager.message({ worker_id: worker.workerId, request_id: 'copilot-steer', message: 'fix', delivery: 'steer' }), /steering/);
  const queued = await c.manager.message({ worker_id: worker.workerId, request_id: 'copilot-queue', message: 'queued' });
  assert.equal(queued.delivery, 'next_turn');
  const alias = await c.profile('copilot');
  await assert.rejects(c.start(alias), /reserved/);
  const aliasState = (await c.manager.profiles()).find((p) => p.id === alias);
  assert.equal(aliasState.busy, true);
  assert.equal(aliasState.reservation, worker.workerId);
  assert.deepEqual(JSON.parse(await readFile(path.join(running.workspace.worktreeDir, 'session-options.json'), 'utf8')), { model: 'fixture-model', reasoningEffort: 'high' });
  await stop(c.manager, worker.workerId);
  await c.manager.resume({ worker_id: worker.workerId, request_id: 'copilot-resume' });
  const resumed = await until(c.manager, worker.workerId, (s) => s.lifecycle === 'ready');
  assert.equal(resumed.nativeSessionId, running.nativeSessionId);
  await c.manager.message({ worker_id: worker.workerId, request_id: 'copilot-continue', message: 'last' });
  const done = await until(c.manager, worker.workerId, (s) => s.lifecycle === 'ready' && s.turn?.number === 3 && s.turn.artifacts);
  assert.equal(await readFile(path.join(done.workspace.worktreeDir, 'received.txt'), 'utf8'), 'hang\nqueued\nlast\n');
  const journal = await readFile(path.join(c.store.require('worker', worker.workerId).directory, 'events.jsonl'), 'utf8');
  assert.match(journal, /Complete answer λ🙂/);
  assert.doesNotMatch(journal, /private-reasoning/);
  await stop(c.manager, worker.workerId);
  await c.manager.release({ worker_id: worker.workerId, request_id: 'copilot-release' });
  assert.ok((await c.manager.artifact({ worker_id: worker.workerId, artifact_id: 'final.patch' })).size > 0);
});

test('Copilot permissions finish and authentication/framing failures never become successes', async () => {
  const c = await context();
  const permission = await c.start(await c.profile('copilot'), 'permission');
  const done = await until(c.manager, permission.workerId, (s) => s.lifecycle === 'ready' && s.turn?.artifacts);
  assert.equal(await readFile(path.join(done.workspace.worktreeDir, 'permission.txt'), 'utf8'), 'approved');
  await stop(c.manager, permission.workerId);
  for (const [task, category] of [['fail', 'authentication'], ['bad-frame', 'protocol']]) {
    const worker = await c.start(await c.profile('copilot'), task);
    const failed = await until(c.manager, worker.workerId, (s) => s.lifecycle === 'stopped' && !s.reserved);
    assert.equal(failed.turn.status, 'failed');
    assert.equal(failed.turn.error.category, category);
    const journal = await readFile(path.join(c.store.require('worker', worker.workerId).directory, 'events.jsonl'), 'utf8');
    assert.doesNotMatch(journal, /private-token-must-not-persist/);
  }
});

test('Copilot rejects isolated or alternate configuration profiles instead of using another account', async () => {
  const c = await context(); const id = await c.profile('copilot');
  const profile = c.store.require('profile', id);
  c.store.put('profile', { ...profile, directory: path.join(root, 'other-copilot') });
  await assert.rejects(c.start(id), /native configuration/);
  c.store.put('profile', { ...profile, isolated: true });
  await assert.rejects(c.start(id), /native configuration/);
});


test('Copilot explicit batches run without overrides and incompatible SDK versions fail before sending prompts', async () => {
  const c = await context(); const profileId = await c.profile('copilot');
  const batch = await c.manager.deploy({ request_id: 'copilot-batch', provider: 'copilot', tasks: [{ profile_id: profileId, cwd: c.directory, task: 'batch' }] });
  const workerId = batch.workers[0].workerId;
  const done = await until(c.manager, workerId, (s) => s.lifecycle === 'ready' && s.turn?.artifacts);
  assert.deepEqual(JSON.parse(await readFile(path.join(done.workspace.worktreeDir, 'session-options.json'), 'utf8')), {});
  await stop(c.manager, workerId);
  const incompatible = fixture + '-protocol4';
  await writeFile(incompatible, await readFile(fixture), { mode: 0o700 });
  const manager = new WorkerManager(c.store, () => installations.map((i) => i.tool === 'copilot' ? { ...i, executable: incompatible } : i));
  const failed = await manager.start({ request_id: 'copilot-version', profile_id: profileId, cwd: c.directory, task: 'must never run' });
  const state = await until(manager, failed.workerId, (s) => s.lifecycle === 'stopped' && !s.reserved);
  assert.equal(state.error.category, 'capability');
  assert.equal(state.turn, undefined);
  await assert.rejects(stat(path.join(state.workspace.worktreeDir, 'received.txt')), { code: 'ENOENT' });
});
