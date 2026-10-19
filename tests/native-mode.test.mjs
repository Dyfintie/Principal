import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
const root = await mkdtemp(path.join(tmpdir(), 'principal-native-tests-'));
process.env.XDG_STATE_HOME = path.join(root, 'state');
process.env.XDG_CONFIG_HOME = path.join(root, 'config');
const { initPaths } = await import('../dist/util.js');
await initPaths();
const { Coordinator } = await import('../dist/coordinator.js');
const { ConfigSchema } = await import('../dist/schema.js');
const directory = path.join(root, 'project');
await (await import('node:fs/promises')).mkdir(directory);
await writeFile(path.join(directory, 'user.txt'), 'existing untracked draft');
function fixture() {
  const c = new Coordinator();
  c.store.db.exec("DELETE FROM leases; DELETE FROM meta WHERE key LIKE 'native_session:%'");
  c.store.saveAccount({ id: 'native-a', label: 'native-a', provider: 'antigravity', identity: null, plan: null, model: null, status: 'ready', generation: 0, lastAssigned: 0 });
  c.store.savePool('native-test', ['native-a']);
  const actions = [];
  let exists = false;
  c.runtime.create = async (account, config, options) => { actions.push(['create', account.id, options]); exists = true; };
  c.runtime.exists = async () => exists;
  c.runtime.interruptNative = async () => { actions.push(['interrupt']); };
  c.runtime.preserveNativeSettings = async () => { actions.push(['settings']); };
  c.runtime.snapshot = async () => { actions.push(['snapshot']); };
  c.runtime.stop = async () => { actions.push(['stop']); exists = false; };
  return { c, actions, config: ConfigSchema.parse({ pool: 'native-test' }) };
}
test('native mode mounts the launch folder directly and excludes the account from other work', async () => {
  const { c, actions, config } = fixture();
  try {
    const session = await c.rpc('native.open', { repo: directory, config, account: 'native-a' });
    assert.equal(session.provider, 'antigravity');
    assert.equal(actions[0][2].workspace, directory);
    assert.equal(actions[0][2].native, true);
    assert.equal(c.store.lease(session.accountId, 'other-work'), false);
    await assert.rejects(c.rpc('native.open', { repo: directory, config, account: 'native-a' }), /busy/);
    assert.equal(await readFile(path.join(directory, 'user.txt'), 'utf8'), 'existing untracked draft');
    assert.equal((await c.rpc('native.heartbeat', { owner: session.owner })).attached, true);
    await c.rpc('native.close', { owner: session.owner });
    assert.deepEqual(actions.slice(1).map(action => action[0]), ['interrupt', 'settings', 'snapshot', 'stop']);
    assert.deepEqual(c.store.leases(), []);
    assert.equal(c.native.list().length, 0);
    assert.deepEqual(await c.rpc('native.close', { owner: session.owner }), { closed: true });
  } finally { c.store.close(); }
});
test('native launch waits for an existing background quota probe without switching accounts', async () => {
  const { c, config } = fixture();
  try {
    c.store.lease('native-a', 'probe-test');
    c.probeJobs.set('native-a', new Promise(resolve => setTimeout(() => { c.store.release('native-a', 'probe-test'); resolve(); }, 10)));
    const session = await c.rpc('native.open', { repo: directory, config, account: 'native-a' });
    assert.equal(session.accountId, 'native-a');
    await c.rpc('native.close', { owner: session.owner });
  } finally { c.store.close(); }
});
test('native launch rejects accounts outside the chosen pool and busy Principal sessions', async () => {
  const { c, config } = fixture();
  try {
    await assert.rejects(c.rpc('native.open', { repo: directory, config, account: 'unknown' }), /ready account/);
    await assert.rejects(c.rpc('native.open', { repo: directory, config, model: 3 }));
    assert.deepEqual(c.store.leases(), []);
    c.store.saveSession({ id: 'native-parent', status: 'running', parentId: null });
    await assert.rejects(c.rpc('native.open', { sessionId: 'native-parent' }), /settle.*\/stop/);
    assert.deepEqual(c.store.leases(), []);
    c.store.db.prepare('DELETE FROM sessions WHERE id=?').run('native-parent');
  } finally { c.store.close(); }
});
test('native attachment survives coordinator restart and expires without replaying provider work', async () => {
  const { c, config, actions } = fixture();
  try {
    const session = await c.rpc('native.open', { repo: directory, config });
    const { NativeSessions } = await import('../dist/native.js');
    c.native = new NativeSessions(c);
    await c.startup();
    assert.equal(c.native.get(session.owner).accountId, session.accountId);
    assert.equal(actions.some(action => action[0] === 'stop'), false);
    c.native.save({ ...session, heartbeatAt: Date.now() - 61000 });
    await c.native.tick();
    assert.equal(c.native.list().length, 0);
    assert.deepEqual(c.store.leases(), []);
    assert.equal(actions.filter(action => action[0] === 'create').length, 1);
  } finally { c.store.close(); }
});
test('failed native cleanup retains the account lease and durable attachment', async () => {
  const { c, config } = fixture();
  try {
    const session = await c.rpc('native.open', { repo: directory, config });
    c.runtime.stop = async () => { throw new Error('Docker unavailable'); };
    await assert.rejects(c.rpc('native.close', { owner: session.owner }), /Docker unavailable/);
    assert.equal(c.store.leases()[0].owner, session.owner);
    assert.equal(c.native.list().length, 1);
  } finally { c.store.close(); }
});
test('native snapshot failures preserve the previous vault and still confirm runtime cleanup', async () => {
  const { c, config } = fixture();
  try {
    const session = await c.rpc('native.open', { repo: directory, config });
    c.runtime.snapshot = async () => { throw new Error('archive limit'); };
    await assert.rejects(c.rpc('native.close', { owner: session.owner }), /latest history.*archive limit/);
    assert.deepEqual(c.store.leases(), []);
    assert.equal(c.native.list().length, 0);
  } finally { c.store.close(); }
});
test('failed native startup releases a lease only after the container is confirmed stopped', async () => {
  const { c, config } = fixture();
  try {
    c.runtime.create = async () => { throw new Error('startup failed'); };
    await assert.rejects(c.rpc('native.open', { repo: directory, config }), /startup failed/);
    assert.deepEqual(c.store.leases(), []);
    assert.equal(c.native.list().length, 0);
  } finally { c.store.close(); }
});
test.after(async () => await rm(root, { recursive: true, force: true }));

test('native home-directory mounts hide Principal state/config and reject credential storage as the working area', async () => {
  const { nativeProtectedMounts } = await import('../dist/runtime.js');
  const protectedRoots = ['/home/user/.local/state/principal', '/home/user/.config/principal'];
  const mounts = nativeProtectedMounts('/home/user', protectedRoots);
  assert.deepEqual(mounts, [
    '/workspace/.local/state/principal:ro,nosuid,nodev,mode=000',
    '/workspace/.config/principal:ro,nosuid,nodev,mode=000',
  ]);
  assert.deepEqual(nativeProtectedMounts('/home/user/project', protectedRoots), []);
  assert.deepEqual(nativeProtectedMounts(protectedRoots[0] + '/sessions/id/workspace', protectedRoots, false), [], 'Private worker captures remain accessible');
  assert.deepEqual(nativeProtectedMounts('/home/user', protectedRoots, false), mounts, 'Principal home conversations also hide the daemon socket and vault');
  assert.deepEqual(nativeProtectedMounts('/home/user/.config/principal-sibling', protectedRoots), []);
  assert.throws(() => nativeProtectedMounts(protectedRoots[0], protectedRoots), /credential storage/);
  assert.throws(() => nativeProtectedMounts(protectedRoots[0] + '/vault', protectedRoots), /credential storage/);
});

test('native working paths retain project identity without shadowing runtime credentials or tools', async () => {
  const { nativeWorkingDirectory, nativeProtectedMounts } = await import('../dist/runtime.js');
  assert.equal(nativeWorkingDirectory('/home/user/project'), '/home/user/project');
  const shadowed = nativeWorkingDirectory('/home/principal/project');
  assert.ok(shadowed.startsWith('/native-workspaces/'));
  assert.equal(shadowed, nativeWorkingDirectory('/home/principal/project'));
  assert.notEqual(shadowed, nativeWorkingDirectory('/home/principal/another'));
  assert.deepEqual(nativeProtectedMounts('/home/user', ['/home/user/.config/principal'], true, '/home/user'), ['/home/user/.config/principal:ro,nosuid,nodev,mode=000']);
});
