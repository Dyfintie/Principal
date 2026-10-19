import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = await mkdtemp(path.join(tmpdir(), 'principal-health-'));
process.env.XDG_STATE_HOME = path.join(root, 'state');
process.env.XDG_RUNTIME_DIR = path.join(root, 'runtime');
process.env.PATH = root + ':/usr/bin:/bin';
await mkdir(process.env.XDG_RUNTIME_DIR);
const { initManagementPaths, environment } = await import('../dist/management/paths.js');
await initManagementPaths();
const { ManagementStore } = await import('../dist/management/store.js');
const { ManagementService } = await import('../dist/management/service.js');
const { detectInstallation } = await import('../dist/management/providers.js');
const { CodexRpcError } = await import('../dist/management/codex.js');
const { compatiblePatch, isCompatibleVersion } = await import('../dist/management/compatibility.js');
const mode = path.join(root, 'mode');
await writeFile(
  path.join(root, 'codex'),
  `#!${process.execPath}
import {readFileSync} from 'node:fs';import {createInterface} from 'node:readline';
if(process.argv.includes('--version')){console.log('0.162.2');process.exit(0);}
const lines=createInterface({input:process.stdin});lines.on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;const mode=readFileSync(${JSON.stringify(mode)},'utf8');
if(r.method==='account/read'&&mode!=='healthy'){console.log(JSON.stringify({id:r.id,error:{code:-32603,message: mode==='auth' ? 'HTTP 401 Unauthorized SYNTHETIC-SECRET-SHOULD-NOT-LEAK' : 'network connection unreachable SYNTHETIC-SECRET-SHOULD-NOT-LEAK',data:{accessToken:'SYNTHETIC-SECRET-SHOULD-NOT-LEAK'}}}));return;}
const result=r.method==='account/read'?{account:{email:'fixture@example.test',planType:'pro'}}:r.method==='account/rateLimits/read'?{rateLimits:{limitId:'codex',primary:{usedPercent:20,windowDurationMins:300}}}:{};
console.log(JSON.stringify({id:r.id,result}));});`,
  { mode: 0o700 },
);
test.after(async () => rm(root, { recursive: true, force: true }));
async function fixture(label) {
  const directory = path.join(root, label);
  await mkdir(directory);
  const store = new ManagementStore(':memory:');
  const service = new ManagementService(store, await environment());
  service.installations = [await detectInstallation('codex')];
  const p = await service.addProfile({ tool: 'codex', label, directory });
  store.put('profile', { ...p, auth: 'authenticated' });
  return { store, service, p };
}

test('typed errors preserve safe codes, classify wrapped 401 and never retain raw provider secrets', () => {
  const error = new CodexRpcError(
    -32603,
    'HTTP 401 Unauthorized bearer SYNTHETIC-SECRET-SHOULD-NOT-LEAK',
  );
  assert.equal(error.code, -32603);
  assert.equal(error.status, 401);
  assert.equal(error.category, 'authentication');
  assert.doesNotMatch(error.message + JSON.stringify(error), /SYNTHETIC-SECRET/);
  assert.equal(new CodexRpcError(-32603, 'quota period expired').category, 'rpc');
  assert.equal(new CodexRpcError(403, 'permission denied').category, 'permission');
  assert.equal(new CodexRpcError(429, 'throttled').category, 'rate-limit');
});
test('401 downgrades cached auth, retains original telemetry and recovers without waiting for old backoff after a successful native inspection', async () => {
  const { store, service, p } = await fixture('auth');
  try {
    await writeFile(mode, 'healthy');
    assert.equal((await service.refreshProfile(p.id)).refreshed, true);
    const observed = store.resources()[0].observedAt;
    await writeFile(mode, 'auth');
    const failed = await service.refreshProfile(p.id);
    assert.equal(failed.refreshed, false);
    assert.match(failed.reason, /401/);
    assert.equal(store.profile(p.id).auth, 'unauthenticated');
    assert.equal(store.resources()[0].observedAt, observed);
    assert.doesNotMatch(JSON.stringify(service.snapshot()), /SYNTHETIC-SECRET/);
    const inspection = await service.inspectProfile(p.id);
    assert.equal(inspection.profile.auth, 'unauthenticated');
    assert.match(inspection.reason, /Sign in/);
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url');
    await writeFile(
      path.join(p.directory, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'x.' + payload + '.x' } }),
    );
    const report = await service.rpc('diagnostics.report');
    assert.equal(report.profiles[0].status, 'Unauthorized');
    assert.equal(report.profiles[0].credential, 'not-expired');
    await writeFile(mode, 'healthy');
    const recovered = await service.inspectProfile(p.id);
    assert.equal(recovered.profile.auth, 'authenticated');
    assert.equal(recovered.profile.observationError, null);
    assert.equal((await service.refreshProfile(p.id)).refreshed, true);
  } finally {
    store.close();
  }
});
test('network failures are structured and do not label cached credentials logged out', async () => {
  const { store, service, p } = await fixture('network');
  try {
    await writeFile(mode, 'network');
    const result = await service.inspectProfile(p.id);
    assert.equal(result.profile.auth, 'authenticated');
    assert.equal(result.profile.observationError.category, 'network');
    const report = await service.rpc('diagnostics.report');
    assert.equal(report.profiles[0].status, 'Unreachable');
  } finally {
    store.close();
  }
});
test('patch families accept stable patches conservatively and disclose unverified compatibility', async () => {
  assert.equal(compatiblePatch('0.162.99', '0.162.1'), true);
  for (const v of ['0.163.0', '0.162.0', '0.162.2-beta', '1.0.0', null])
    assert.equal(compatiblePatch(v, '0.162.1'), false);
  assert.equal(isCompatibleVersion('0.163.0', '0.162.1'), true);
  assert.equal(isCompatibleVersion('0.162.99', '0.162.1'), true);
  assert.equal(isCompatibleVersion('1.0.0', '0.162.1'), false);
  assert.equal(isCompatibleVersion('1.4.0', '1.3.3'), true);
  assert.equal(isCompatibleVersion('2.0.0', '1.3.3'), false);
  assert.equal(isCompatibleVersion('0.162.0', '0.162.1'), false);
  assert.equal(isCompatibleVersion(null, '0.162.1'), false);
  const installed = await detectInstallation('codex');
  assert.equal(installed.capabilities.resources.supported, true);
  assert.equal(installed.capabilities.resources.confidence, 'unverified');
});
test('forward-compatible versions auto-adapt dynamically across minor/patch updates', async () => {
  await writeFile(
    path.join(root, 'codex'),
    `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('0.164.0');process.exit(0);}\n`,
    { mode: 0o700 },
  );
  const installed = await detectInstallation('codex');
  assert.equal(installed.version, '0.164.0');
  assert.equal(installed.verifiedVersion, true);
  assert.equal(installed.capabilities.resources.supported, true);
  assert.equal(installed.capabilities.resources.confidence, 'unverified');
  assert.match(installed.capabilities.resources.reason, /Compatible version family 0\.164\.0/);
});
test('codex 0.163.0 is officially recognized with verified-interface confidence', async () => {
  await writeFile(
    path.join(root, 'codex'),
    `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('0.163.0');process.exit(0);}\n`,
    { mode: 0o700 },
  );
  const installed = await detectInstallation('codex');
  assert.equal(installed.version, '0.163.0');
  assert.equal(installed.verifiedVersion, true);
  assert.equal(installed.capabilities.resources.supported, true);
  assert.equal(installed.capabilities.resources.confidence, 'verified-interface');
  assert.match(installed.capabilities.resources.reason, /Interface verified for 0\.163\.0/);
});

test('indexed pruning uses real ISO timestamps and preserves profiles, conversations, live sightings and bindings', () => {
  const store = new ManagementStore(':memory:');
  try {
    const now = Date.now(),
      old = new Date(now - 8 * 86400000).toISOString();
    store.put('resource', { id: 'old', observedAt: old });
    store.put('resource', { id: 'new', observedAt: new Date(now).toISOString() });
    store.put('profile', { id: 'profile' });
    store.put('conversation', { id: 'conversation' });
    store.put('entry', { id: 'external', conversationId: null });
    store.put('invocation', {
      id: 'external-run',
      entryId: 'external',
      owned: false,
      lifecycle: 'exited',
      endedAt: old,
    });
    store.put('entry', { id: 'bound', conversationId: 'conversation' });
    store.put('invocation', {
      id: 'bound-run',
      entryId: 'bound',
      owned: false,
      lifecycle: 'exited',
      endedAt: old,
    });
    store.put('entry', { id: 'active', conversationId: null });
    store.put('invocation', {
      id: 'active-run',
      entryId: 'active',
      owned: false,
      lifecycle: 'running',
      endedAt: null,
    });
    assert.deepEqual(store.prune(now), { resources: 1, externalSightings: 1 });
    assert.equal(store.get('resource', 'old'), null);
    assert.ok(store.get('resource', 'new'));
    assert.ok(store.get('profile', 'profile'));
    assert.ok(store.get('conversation', 'conversation'));
    assert.ok(store.get('invocation', 'bound-run'));
    assert.ok(store.get('invocation', 'active-run'));
    assert.match(
      JSON.stringify(
        store.db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT data FROM records WHERE kind='binding' AND json_extract(data,'$.invocationId')=? AND json_extract(data,'$.endedAt') IS NULL",
          )
          .all('bound-run'),
      ),
      /binding_invocation/,
    );
  } finally {
    store.close();
  }
});
