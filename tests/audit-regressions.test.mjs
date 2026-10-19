import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = await mkdtemp(path.join(tmpdir(), 'principal-audit-'));
process.env.XDG_STATE_HOME = root;
const { redact, initPaths } = await import('../dist/util.js');
const { classifyProviderFailure, codexQuota } = await import('../dist/providers/quota.js');
const { selectAccount } = await import('../dist/scheduler.js');
const { ConfigSchema } = await import('../dist/schema.js');
const { Repository, git } = await import('../dist/repository.js');
const { Vault } = await import('../dist/vault.js');
const { Store } = await import('../dist/store.js');
const { Coordinator } = await import('../dist/coordinator.js');
await initPaths();
test.after(async () => rm(root, { recursive: true, force: true }));
test('redaction preserves JSON with commas, whitespace, escapes and nested secrets', () => {
  const input = {
    access_token: 'first,second part',
    nested: [{ authorization: 'Bearer two words' }],
    text: 'task-graph and mask-value',
    escaped: 'quote " and newline\n',
  };
  const output = JSON.parse(redact(JSON.stringify(input)));
  assert.equal(output.access_token, '[redacted]');
  assert.equal(output.nested[0].authorization, '[redacted]');
  assert.equal(output.text, input.text);
  assert.equal(output.escaped, input.escaped);
});
test('only explicit protocol errors change account or quota state', () => {
  for (const text of [
    'sign in test failed',
    'Fix quota calculation',
    'access denied',
    'account suspended in fixture',
  ]) {
    assert.equal(classifyProviderFailure(text), 'failed');
    assert.equal(classifyProviderFailure({ message: text }), 'failed');
  }
  assert.equal(classifyProviderFailure({ codexErrorInfo: 'usageLimitExceeded' }), 'quota');
  assert.equal(
    classifyProviderFailure({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }),
    'auth',
  );
  assert.equal(classifyProviderFailure({ codexErrorInfo: 'cyberPolicy' }), 'failed');
  assert.equal(classifyProviderFailure({ error: { code: 'account_suspended' } }), 'policy');
});
test('seconds and milliseconds yield the same reset time', () => {
  const q = (value) =>
    codexQuota('fixture', { rateLimits: { primary: { usedPercent: 0, resetsAt: value } } })
      .buckets[0].resetAt;
  assert.equal(q(1791350000), q(1791350000000));
  assert.equal(q(Infinity), null);
});
test('scheduler accepts pinned account IDs', () => {
  const accounts = [
    {
      id: 'fixture-id',
      label: 'fixture-label',
      provider: 'codex',
      status: 'ready',
      lastAssigned: 0,
    },
  ];
  assert.equal(
    selectAccount(
      { spec: { account: 'fixture-id', allowFallback: false }, attempts: 0 },
      accounts,
      () => null,
      new Set(),
      ConfigSchema.parse({ routing: { allowUnknownQuota: true } }),
    ).id,
    'fixture-id',
  );
});
test('vault wipes the key when writing the encrypted file fails', async () => {
  const vault = new Vault(),
    key = Buffer.alloc(32, 123);
  vault.key = async () => key;
  await assert.rejects(vault.save('missing/directory', 'codex', 0, Buffer.from('fixture')));
  assert.ok(key.every((byte) => byte === 0));
});
test('events remain readable and malformed legacy payloads are withheld', () => {
  const store = new Store();
  try {
    store.saveRun({ id: 'fixture-run' });
    store.event('fixture-run', 'fixture', { access_token: 'one,two words' });
    assert.equal(store.events('fixture-run')[0].data.access_token, '[redacted]');
    store.db.prepare('UPDATE events SET data=?').run('{bad');
    assert.match(store.events('fixture-run')[0].data.error, /malformed/);
  } finally {
    store.close();
  }
});
test('busy refresh preserves quota and does not add probe backoff', async () => {
  const c = Object.create(Coordinator.prototype),
    quota = { state: 'reported' };
  c.probeErrors = new Map();
  c.store = {
    lease: () => false,
    quota: () => quota,
    saveQuota: () => assert.fail('quota overwritten'),
  };
  assert.equal(await c.refresh({ id: 'fixture', label: 'fixture' }, ConfigSchema.parse({})), quota);
  assert.equal(c.probeErrors.size, 0);
});
test('checkpoint rejects newly added symlinks and accepts regular files/deletions', async () => {
  const source = path.join(root, 'repo');
  await mkdir(source);
  await git(source, ['init', '-q']);
  await writeFile(path.join(source, 'base.txt'), 'base');
  await git(source, ['add', '.']);
  await git(source, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    'base',
  ]);
  const base = (await git(source, ['rev-parse', 'HEAD'])).stdout.toString().trim();
  const repo = new Repository(),
    run = { id: 'fixture-checkpoint', repo: source, base };
  const task = { id: 'write', spec: { mode: 'write', writePaths: ['**'], dependsOn: [] } };
  await repo.prepare(run);
  const workspace = await repo.workspace(run, task, 'fixture-attempt', []);
  await symlink('/home/varun/.ssh/id_rsa', path.join(workspace, 'leak'));
  await assert.rejects(repo.checkpoint(run, task, 'fixture-attempt', workspace, []), /non-regular/);
  await rm(path.join(workspace, 'leak'));
  await rm(path.join(workspace, 'base.txt'));
  await writeFile(path.join(workspace, 'new.txt'), 'new');
  const checkpoint = await repo.checkpoint(run, task, 'fixture-attempt', workspace, []);
  assert.deepEqual(checkpoint.files.sort(), ['base.txt', 'new.txt']);
  // Even an older checkpoint introduced before this check cannot bypass integration.
  const blob = (await git(source, ['hash-object', '--stdin'], '/tmp/fixture')).stdout
    .toString()
    .trim();
  const patch = Buffer.from(
    'diff --git a/link b/link\nnew file mode 120000\nindex 0000000..' +
      blob +
      '\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+/tmp/fixture\n\\ No newline at end of file\n',
  );
  const clean = await repo.workspace(run, task, 'patch-test', []);
  await assert.rejects(repo.applyPatch(clean, patch), /non-regular/);
  await git(clean, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    'Unsafe old checkpoint',
  ]);
  const commit = (await git(clean, ['rev-parse', 'HEAD'])).stdout.toString().trim();
  await assert.rejects(
    repo.apply({
      ...run,
      status: 'ready_for_review',
      integration: clean,
      integrationCommit: commit,
      checkedCommit: commit,
    }),
    /non-regular/,
  );
  assert.equal((await git(source, ['rev-parse', 'HEAD'])).stdout.toString().trim(), base);
});
test('startup removes exited attempt containers before releasing the account', async () => {
  const c = Object.create(Coordinator.prototype),
    calls = [];
  const attempt = {
    id: 'attempt',
    accountId: 'account',
    container: 'stopped',
    status: 'running',
    runId: 'run',
    taskId: 'task',
  };
  const run = { id: 'run', status: 'running' },
    task = { id: 'task' };
  c.store = {
    runs: () => [run],
    attempts: () => [attempt],
    saveAttempt: () => {},
    run: () => run,
    saveRun: () => {},
    tasks: () => [task],
    saveTask: () => {},
    leases: () => [],
    release: () => calls.push('release'),
  };
  c.runtime = { exists: async () => false, stop: async () => calls.push('remove') };
  c.sessions = { startup: async () => {} };
  await c.startup();
  assert.deepEqual(calls, ['remove', 'release']);
  assert.equal(attempt.status, 'needs_review');
});
test('prune cleans managed run containers before deleting records', async () => {
  const c = Object.create(Coordinator.prototype),
    calls = [];
  c.integrationJobs = new Set();
  c.planningJobs = new Set();
  c.store = {
    run: () => ({ id: 'fixture-prune' }),
    attempts: () => [],
    leases: () => [],
    db: { prepare: () => ({ run: () => calls.push('delete') }) },
  };
  c.repo = { runDir: () => path.join(root, 'fixture-prune') };
  c.runtime = {
    removeRun: async (id) => {
      assert.equal(id, 'fixture-prune');
      calls.push('remove');
    },
  };
  await c.handleRpc('runs.prune', { id: 'fixture-prune' });
  assert.deepEqual(calls, ['remove', 'delete']);
});

test('stale and malformed observations cannot route with unknown quota enabled', () => {
  const account = { id: 'quota-fixture', provider: 'codex', status: 'ready', lastAssigned: 0 };
  const config = ConfigSchema.parse({ routing: { allowUnknownQuota: true } });
  for (const q of [
    { state: 'stale', observedAt: new Date().toISOString(), buckets: [] },
    { state: 'unknown', observedAt: 'invalid', buckets: [] },
  ]) {
    assert.equal(
      selectAccount({ spec: {}, attempts: 0 }, [account], () => q, new Set(), config),
      null,
    );
  }
});
test('Codex merges legacy limits and mapped limits and accepts numeric string epochs', () => {
  const q = codexQuota('fixture', {
    rateLimits: { primary: { usedPercent: 12, resetsAt: '1791350000' } },
    rateLimitsByLimitId: { other: { primary: { usedPercent: 34, resetsAt: '1791350000000' } } },
  });
  assert.deepEqual(
    q.buckets.map((b) => b.remainingPercent),
    [88, 66],
  );
  assert.equal(q.buckets[0].resetAt, q.buckets[1].resetAt);
  assert.equal(
    codexQuota('fixture', { rateLimits: { primary: { usedPercent: 0 } }, rateLimitsByLimitId: {} })
      .buckets.length,
    1,
  );
});
test('redaction covers property aliases, standalone provider tokens and non-string errors', () => {
  const output = JSON.parse(
    redact({
      accessToken: 'fixture',
      apiKey: 'fixture',
      clientSecret: 'fixture',
      password: 'fixture',
    }),
  );
  assert.ok(Object.values(output).every((v) => v === '[redacted]'));
  assert.equal(redact(new Error('Bearer fixture')), '[redacted]');
  assert.equal(redact(42), '42');
  for (const value of [
    '1//fixture-token',
    'AIzaSyfixture',
    'ghp_fixture',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.signature',
  ])
    assert.equal(redact(value), '[redacted]');
});
test('stop failure retains the lease if runtime is running or Docker state is unknown', async () => {
  for (const exists of [
    async () => true,
    async () => {
      throw new Error('Docker unavailable');
    },
  ]) {
    const c = Object.create(Coordinator.prototype);
    c.store = { release: () => assert.fail('lease released'), leases: () => [] };
    c.runtime = {
      stop: async () => {
        throw new Error('stop failed');
      },
      exists,
    };
    await assert.rejects(c.safeStopAndRelease('account', 'owner', 'container'));
  }
});
test('quota exhaustion blocks an account even before its first successful probe', () => {
  const c = Object.create(Coordinator.prototype);
  let saved;
  c.store = {
    quota: () => null,
    saveQuota: (q) => {
      saved = q;
    },
  };
  c.blockQuota({ id: 'fixture', provider: 'codex', model: 'fixture-model' }, null, 'exhausted');
  assert.equal(saved.state, 'unknown');
  assert.deepEqual(saved.blockedModels, ['fixture-model']);
});
test('versioned vault snapshots reject replay and retain separately addressed generations', async () => {
  const vault = new Vault();
  vault.key = async () => Buffer.alloc(32, 123);
  await vault.save('versioned', 'codex', 1, Buffer.from('first'));
  await vault.save('versioned', 'codex', 2, Buffer.from('second'));
  assert.equal((await vault.load('versioned', 'codex', 1)).toString(), 'first');
  const { readFile } = await import('node:fs/promises');
  await writeFile(
    path.join(root, 'principal/vault/versioned.2.enc'),
    await readFile(path.join(root, 'principal/vault/versioned.1.enc')),
  );
  await assert.rejects(vault.load('versioned', 'codex', 2), /metadata mismatch/);
  assert.equal((await vault.load('versioned', 'codex', 1)).toString(), 'first');
  await assert.rejects(vault.load('versioned', 'codex', 3), /ENOENT/);
});
test('prune rejects active queued runs and stops residual actor leases', async () => {
  const c = Object.create(Coordinator.prototype),
    calls = [];
  c.integrationJobs = new Set();
  c.planningJobs = new Set();
  const run = { id: 'prune-residual', status: 'queued' };
  c.store = {
    run: () => run,
    attempts: () => [],
    leases: () => [{ accountId: 'a', owner: 'plan-prune-residual-fixture', container: 'actor' }],
    release: () => calls.push('release'),
    db: { prepare: () => ({ run: () => calls.push('delete') }) },
  };
  c.runtime = {
    stop: async () => calls.push('stop'),
    exists: async () => false,
    removeRun: async () => calls.push('removeRun'),
  };
  c.repo = { runDir: () => path.join(root, 'prune-residual') };
  await assert.rejects(c.handleRpc('runs.prune', { id: run.id }), /Cancel or finish/);
  run.status = 'canceled';
  await c.handleRpc('runs.prune', { id: run.id });
  assert.deepEqual(calls, ['stop', 'release', 'removeRun', 'delete']);
});
test('nested Git control files are rejected at checkpoint and host apply', async () => {
  const repo = new Repository(),
    source = path.join(root, 'repo');
  const base = (await git(source, ['rev-parse', 'HEAD'])).stdout.toString().trim();
  const run = { id: 'control-files', repo: source, base };
  const task = { id: 'write', spec: { mode: 'write', writePaths: ['**'], dependsOn: [] } };
  await repo.prepare(run);
  for (const file of ['.gitattributes', '.gitmodules', 'sub/.gitattributes']) {
    const workspace = await repo.workspace(run, task, file.replaceAll('/', '-'), []);
    await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await writeFile(path.join(workspace, file), 'fixture');
    await assert.rejects(
      repo.checkpoint(run, task, 'control-checkpoint', workspace, []),
      /Disallowed artifact path/,
    );
  }
  const imported = await repo.workspace(run, task, 'control-host-apply', []);
  await writeFile(path.join(imported, '.gitattributes'), 'fixture');
  await git(imported, ['add', '.']);
  await git(imported, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    'unsafe attributes',
  ]);
  const integrationCommit = (await git(imported, ['rev-parse', 'HEAD'])).stdout.toString().trim();
  await assert.rejects(
    repo.apply({
      ...run,
      status: 'ready_for_review',
      integration: imported,
      integrationCommit,
      checkedCommit: integrationCommit,
    }),
    /Disallowed artifact path/,
  );
  assert.equal((await git(source, ['rev-parse', 'HEAD'])).stdout.toString().trim(), base);
  assert.throws(() => repo.validatePath('sub/.git'), /Disallowed artifact path/);
  assert.doesNotThrow(() => repo.validatePath('.github/workflows/ci.yml'));
});
test('startup tolerates an attempt whose task record is missing', async () => {
  const c = Object.create(Coordinator.prototype);
  const attempt = {
    id: 'orphan',
    accountId: 'a',
    runId: 'r',
    taskId: 'missing',
    container: 'exited',
    status: 'running',
  };
  const run = { id: 'r' };
  c.store = {
    runs: () => [run],
    attempts: () => [attempt],
    run: () => run,
    tasks: () => [],
    leases: () => [],
    saveAttempt: () => {},
    saveRun: () => {},
    saveTask: () => assert.fail('missing task saved'),
    release: () => {},
  };
  c.runtime = { stop: async () => {}, exists: async () => false };
  c.sessions = { startup: async () => {} };
  await c.startup();
  assert.equal(run.status, 'needs_review');
});
test('planner deadline releases a confirmed stopped actor without waiting indefinitely', async () => {
  const c = Object.create(Coordinator.prototype),
    source = path.join(root, 'repo');
  const account = { id: 'planner-fixture', provider: 'codex', status: 'ready', model: 'fixture' };
  let released = false;
  c.store = {
    pool: () => [account.id],
    account: () => account,
    lease: () => true,
    setContainer: () => {},
    release: () => {
      released = true;
    },
    leases: () => [],
  };
  const clock = Date.now;
  c.runtime = {
    create: async () => {},
    stop: async () => {},
    exists: async () => false,
    call: async () => {
      let first = true;
      Date.now = () => {
        if (first) {
          first = false;
          return 0;
        }
        return 1e9;
      };
    },
  };
  try {
    await assert.rejects(
      c.plan({
        repo: source,
        pool: 'fixture',
        goal: 'fixture',
        config: { attemptTimeoutSeconds: 60 },
      }),
      /Planning deadline exceeded/,
    );
    assert.equal(released, true);
  } finally {
    Date.now = clock;
  }
});

test('runtime advances generation only after the database pointer commits', async () => {
  const { Runtime } = await import('../dist/runtime.js');
  const account = { id: 'generation-fixture', provider: 'codex', generation: 0 };
  const calls = [];
  const runtime = new Runtime(() => {
    throw new Error('DB write failed');
  });
  runtime.vault = {
    save: async (...args) => calls.push(['save', args[2]]),
    discardGeneration: async () => calls.push(['discard']),
  };
  await assert.rejects(runtime.saveSnapshot(account, Buffer.from('fixture')), /DB write failed/);
  assert.equal(account.generation, 0);
  assert.deepEqual(calls, [['save', 1]]);
  const committed = new Runtime((_account, generation) => calls.push(['commit', generation]));
  committed.vault = runtime.vault;
  await committed.saveSnapshot(account, Buffer.from('fixture'));
  assert.equal(account.generation, 1);
  assert.deepEqual(calls.slice(1), [['save', 1], ['commit', 1], ['discard']]);
});

test('account removal retains credentials and records when logout runtime cleanup fails', async () => {
  const c = Object.create(Coordinator.prototype),
    account = { id: 'removal-fixture' };
  let leased = false;
  c.store = {
    account: () => account,
    sessions: () => [],
    runs: () => [],
    leases: () => (leased ? [{ accountId: account.id }] : []),
  };
  c.isolated = async () => {
    leased = true;
    throw new Error('Docker stop failed');
  };
  c.runtime = { vault: { remove: () => assert.fail('credentials removed') } };
  await assert.rejects(
    c.handleRpc('accounts.remove', { account: account.id }),
    /cleanup is unconfirmed/,
  );
});
