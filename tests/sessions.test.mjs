import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, chmod, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
const root = await mkdtemp(path.join(tmpdir(), 'principal-sessions-'));
process.env.XDG_STATE_HOME = path.join(root, 'state');
process.env.XDG_CONFIG_HOME = path.join(root, 'config');
const { initPaths } = await import('../dist/util.js');
await initPaths();
const { Coordinator } = await import('../dist/coordinator.js');
const { git } = await import('../dist/repository.js');
const { capture, hostState, review, apply, recoverApply } = await import(
  '../dist/session-workspace.js'
);
const { bounded, commitCheckpoint } = await import('../dist/session-context.js');
const { ConfigSchema } = await import('../dist/schema.js');
async function repo() {
  const dir = await mkdtemp(path.join(root, 'repo-'));
  await git(dir, ['init', '--quiet']);
  for (const [file, text] of Object.entries({
    'a.txt': 'base\n',
    'delete.txt': 'delete\n',
    '.gitignore': 'ignored\n',
  }))
    await writeFile(path.join(dir, file), text);
  await git(dir, ['add', '.']);
  await git(dir, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@localhost',
    'commit',
    '--quiet',
    '-m',
    'base',
  ]);
  return dir;
}
test('startup explains non-repositories and missing committed baselines', async () => {
  const dir = await mkdtemp(path.join(root, 'unborn-'));
  await assert.rejects(hostState(dir), /Principal needs a Git project/);
  await git(dir, ['init', '--quiet']);
  await writeFile(path.join(dir, 'draft.txt'), 'user draft\n');
  await assert.rejects(hostState(dir), /at least one commit.*no usable HEAD/);
  assert.equal(await readFile(path.join(dir, 'draft.txt'), 'utf8'), 'user draft\n');
});
function coordinator() {
  const c = new Coordinator();
  for (const [id, provider] of [
    ['a', 'codex'],
    ['b', 'antigravity'],
  ])
    c.store.saveAccount({
      id,
      label: id,
      provider,
      identity: null,
      plan: null,
      model: null,
      status: 'ready',
      generation: 0,
      lastAssigned: 0,
    });
  c.store.savePool('development', ['a', 'b']);
  return c;
}
async function editPrivate(s) {
  await writeFile(path.join(s.workspace, 'a.txt'), 'agent\n');
  await writeFile(path.join(s.workspace, 'new.bin'), Buffer.from([0, 1, 255, 2]));
  await rm(path.join(s.workspace, 'delete.txt'), { force: true });
  await git(s.workspace, ['add', '--all']);
  await git(s.workspace, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@localhost',
    'commit',
    '--quiet',
    '-m',
    'agent',
  ]);
}
test('enrolled account pool insertion is additive, idempotent, and rejects incomplete sign-in', async () => {
  const c = coordinator();
  try {
    await c.rpc('pools.addAccount', { pool: 'development', account: 'a' });
    assert.deepEqual(c.store.pool('development'), ['a', 'b']);
    await c.rpc('pools.addAccount', { pool: 'first-run', account: 'a' });
    await c.rpc('pools.addAccount', { pool: 'first-run', account: 'a' });
    assert.deepEqual(c.store.pool('first-run'), ['a']);
    const account = c.store.account('b');
    account.status = 'auth_required';
    c.store.saveAccount(account);
    await assert.rejects(
      c.rpc('pools.addAccount', { pool: 'first-run', account: 'b' }),
      /Complete account sign-in/,
    );
    assert.deepEqual(c.store.pool('first-run'), ['a']);
  } finally {
    c.store.close();
  }
});
test('plain and unborn directories admit chat immediately; pruning never removes user files', async () => {
  for (const unborn of [false, true]) {
    const c = coordinator();
    try {
      const dir = await mkdtemp(path.join(root, 'directory-chat-'));
      await writeFile(path.join(dir, 'note.txt'), 'user notes\n');
      if (unborn) await git(dir, ['init', '--quiet']);
      const s = await c.sessions.create({ repo: dir, lead: 'a' });
      assert.equal(s.repo, dir);
      assert.equal(s.workspace, dir);
      assert.equal(s.liveDirectory, true);
      const receipt = await c.sessions.submit({
        id: s.id,
        clientMessageId: 'hello',
        input: 'hello',
      });
      assert.equal(receipt.status, 'queued');
      receipt.status = 'interrupted';
      c.store.saveTurn(receipt);
      s.status = 'stopped';
      c.store.saveSession(s);
      await c.sessions.rpc('sessions.prune', { id: s.id });
      assert.equal(await readFile(path.join(dir, 'note.txt'), 'utf8'), 'user notes\n');
      if (!unborn) await assert.rejects(readFile(path.join(dir, '.git', 'HEAD')), /ENOENT/);
    } finally {
      c.store.close();
    }
  }
});
test('directory snapshots support reviewed apply without creating host Git metadata', async () => {
  const c = coordinator();
  try {
    const dir = await mkdtemp(path.join(root, 'directory-edit-'));
    await writeFile(path.join(dir, 'a.txt'), 'user\n');
    await writeFile(path.join(dir, 'delete.txt'), 'base\n');
    await writeFile(path.join(dir, '.gitignore'), 'ignored\n');
    await writeFile(path.join(dir, 'ignored'), 'secret\n');
    const s = await c.sessions.create({ repo: dir });
    Object.assign(s, await capture(dir, s.id, true));
    await assert.rejects(readFile(path.join(s.workspace, 'ignored')), /ENOENT/);
    await editPrivate(s);
    s.workspaceVersion++;
    c.store.saveSession(s);
    await c.sessions.rpc('sessions.review', { id: s.id });
    await c.sessions.rpc('sessions.apply', { id: s.id });
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'agent\n');
    assert.equal(await readFile(path.join(dir, 'ignored'), 'utf8'), 'secret\n');
    await assert.rejects(readFile(path.join(dir, '.git', 'HEAD')), /ENOENT/);
  } finally {
    c.store.close();
  }
});
test('directory apply preserves an unborn repository index and never creates a host commit', async () => {
  const c = coordinator();
  try {
    const dir = await mkdtemp(path.join(root, 'unborn-edit-'));
    await git(dir, ['init', '--quiet']);
    await writeFile(path.join(dir, 'a.txt'), 'staged\n');
    await writeFile(path.join(dir, 'delete.txt'), 'base\n');
    await git(dir, ['add', '.']);
    await writeFile(path.join(dir, 'a.txt'), 'user unstaged\n');
    const index = await readFile(path.join(dir, '.git', 'index'));
    const s = await c.sessions.create({ repo: dir });
    Object.assign(s, await capture(dir, s.id, true));
    assert.equal(await readFile(path.join(s.workspace, 'a.txt'), 'utf8'), 'user unstaged\n');
    await editPrivate(s);
    s.workspaceVersion++;
    c.store.saveSession(s);
    await c.sessions.rpc('sessions.review', { id: s.id });
    await c.sessions.rpc('sessions.apply', { id: s.id });
    assert.deepEqual(await readFile(path.join(dir, '.git', 'index')), index);
    await assert.rejects(git(dir, ['rev-parse', '--verify', 'HEAD']));
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'agent\n');
  } finally {
    c.store.close();
  }
});
test('launching in a repository subdirectory keeps that directory as the working area', async () => {
  const c = coordinator();
  try {
    const parent = await repo(),
      dir = path.join(parent, 'nested');
    await mkdir(dir);
    await writeFile(path.join(dir, 'local.txt'), 'local\n');
    const s = await c.sessions.create({ repo: dir });
    assert.equal(s.repo, dir);
    assert.equal(s.workspace, dir);
    Object.assign(s, await capture(dir, s.id, true));
    assert.equal(await readFile(path.join(s.workspace, 'local.txt'), 'utf8'), 'local\n');
    await assert.rejects(readFile(path.join(s.workspace, 'a.txt')), /ENOENT/);
  } finally {
    c.store.close();
  }
});
test('dirty capture includes staged, unstaged, untracked and staged deletions without changing index', async () => {
  const dir = await repo();
  await writeFile(path.join(dir, 'a.txt'), 'staged\n');
  await git(dir, ['add', 'a.txt']);
  await writeFile(path.join(dir, 'a.txt'), 'unstaged\n');
  await git(dir, ['rm', 'delete.txt']);
  await writeFile(path.join(dir, 'untracked'), 'user\n');
  await writeFile(path.join(dir, 'ignored'), 'secret\n');
  const before = await hostState(dir),
    s = await capture(dir, 'capture');
  assert.equal(await readFile(path.join(s.workspace, 'a.txt'), 'utf8'), 'unstaged\n');
  assert.equal(await readFile(path.join(s.workspace, 'untracked'), 'utf8'), 'user\n');
  await assert.rejects(readFile(path.join(s.workspace, 'delete.txt')), /ENOENT/);
  await assert.rejects(readFile(path.join(s.workspace, 'ignored')), /ENOENT/);
  assert.equal((await hostState(dir)).fingerprint, before.fingerprint);
});
test('review and unstaged apply preserve HEAD, index, user untracked files and binary bytes', async () => {
  const c = coordinator();
  try {
    const dir = await repo();
    await writeFile(path.join(dir, 'a.txt'), 'staged\n');
    await git(dir, ['add', 'a.txt']);
    await writeFile(path.join(dir, 'a.txt'), 'user\n');
    await writeFile(path.join(dir, 'untracked'), 'keep\n');
    const before = await hostState(dir);
    const s = await c.sessions.create({ repo: dir, lead: 'a' });
    await editPrivate(s);
    s.workspaceVersion++;
    c.store.saveSession(s);
    await assert.rejects(c.sessions.rpc('sessions.apply', { id: s.id }), /Review/);
    await c.sessions.rpc('sessions.review', { id: s.id });
    await c.sessions.rpc('sessions.apply', { id: s.id });
    const after = await hostState(dir);
    assert.equal(after.head, before.head);
    assert.equal(after.indexHash, before.indexHash);
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'agent\n');
    assert.equal(await readFile(path.join(dir, 'untracked'), 'utf8'), 'keep\n');
    assert.deepEqual(await readFile(path.join(dir, 'new.bin')), Buffer.from([0, 1, 255, 2]));
    await assert.rejects(readFile(path.join(dir, 'delete.txt')), /ENOENT/);
    assert.equal((await c.sessions.rpc('sessions.review', { id: s.id })).patch, '');
  } finally {
    c.store.close();
  }
});
test('host drift rejects application and refresh reconciles independent user edits', async () => {
  const c = coordinator();
  try {
    const dir = await repo();
    const s = await c.sessions.create({ repo: dir });
    await editPrivate(s);
    s.workspaceVersion++;
    c.store.saveSession(s);
    await c.sessions.rpc('sessions.review', { id: s.id });
    await writeFile(path.join(dir, 'user-new'), 'concurrent\n');
    await assert.rejects(c.sessions.rpc('sessions.apply', { id: s.id }), /drift/);
    await c.sessions.rpc('sessions.refresh', { id: s.id });
    await assert.rejects(c.sessions.rpc('sessions.apply', { id: s.id }), /Review/);
    await c.sessions.rpc('sessions.review', { id: s.id });
    await c.sessions.rpc('sessions.apply', { id: s.id });
    assert.equal(await readFile(path.join(dir, 'user-new'), 'utf8'), 'concurrent\n');
  } finally {
    c.store.close();
  }
});
test('duplicate admission and overflow preserve FIFO and original receipt', async () => {
  const c = coordinator();
  try {
    const s = await c.sessions.create({ repo: await repo() });
    const args = { id: s.id, clientMessageId: 'first', input: 'hi' };
    const one = await c.sessions.submit(args),
      two = await c.sessions.submit(args);
    assert.equal(one.id, two.id);
    assert.equal(c.store.turns(s.id).length, 1);
    await assert.rejects(c.sessions.submit({ ...args, input: 'changed' }), /reused/);
    for (let i = 1; i < 32; i++)
      await c.sessions.submit({ id: s.id, clientMessageId: `m${i}`, input: `input ${i}` });
    await assert.rejects(
      c.sessions.submit({ id: s.id, clientMessageId: 'overflow', input: 'preserved draft' }),
      /Inbox full/,
    );
    assert.equal(c.store.turns(s.id).length, 32);
    assert.equal(c.store.messages(s.id, 0, 100).filter((m) => m.role === 'user').length, 32);
    assert.equal(c.store.turns(s.id).at(-1).input, 'input 31');
  } finally {
    c.store.close();
  }
});
test('restart marks dispatch ambiguity for review without replaying admitted input', async () => {
  const c = coordinator();
  try {
    const s = await c.sessions.create({ repo: await repo() });
    const t = await c.sessions.submit({ id: s.id, clientMessageId: 'crash', input: 'do work' });
    t.status = 'dispatching';
    t.dispatchAt = new Date().toISOString();
    c.store.saveTurn(t);
    await c.sessions.startup();
    assert.equal(c.store.session(s.id).status, 'needs_review');
    assert.equal(c.store.turns(s.id)[0].status, 'needs_review');
    await c.sessions.advance(s.id);
    assert.equal(c.store.turns(s.id).length, 1);
  } finally {
    c.store.close();
  }
});
test('checkpoint is portable, canonical history survives compaction, Unicode previews are bounded', async () => {
  const c = coordinator();
  try {
    const s = await c.sessions.create({ repo: await repo() });
    await c.sessions.submit({
      id: s.id,
      clientMessageId: 'context',
      input: 'Keep existing index and correction X',
    });
    const cp = commitCheckpoint(c.store, s, 'Objective X; correction X; pending Y; artifact Z');
    assert.match(cp.constraints, /recursiveDelegation/);
    assert.match(cp.recent, /correction X/);
    await c.sessions.rpc('sessions.compact', { id: s.id });
    assert.equal(c.store.messages(s.id).length, 1);
    const preview = bounded('🙂'.repeat(10000) + '\nend');
    assert.ok(Buffer.byteLength(preview) <= 8192);
    assert.ok(!preview.includes('�'));
  } finally {
    c.store.close();
  }
});
test('baseline and apply reject symlinks and ignored host collisions', async () => {
  const c = coordinator();
  try {
    const dir = await repo();
    await symlink('/etc/passwd', path.join(dir, 'link'));
    await assert.rejects(capture(dir, 'unsafe'), /Non-regular/);
    await rm(path.join(dir, 'link'));
    const s = await c.sessions.create({ repo: dir });
    await writeFile(path.join(s.workspace, 'ignored'), 'agent\n');
    await git(s.workspace, ['add', '--force', 'ignored']);
    await git(s.workspace, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@localhost',
      'commit',
      '--quiet',
      '-m',
      'ignored',
    ]);
    await writeFile(path.join(dir, 'ignored'), 'user secret\n');
    await c.sessions.rpc('sessions.review', { id: s.id });
    await assert.rejects(c.sessions.rpc('sessions.apply', { id: s.id }), /Uncaptured/);
    assert.equal(await readFile(path.join(dir, 'ignored'), 'utf8'), 'user secret\n');
  } finally {
    c.store.close();
  }
});
test('failed native compaction retains previous checkpoint', async () => {
  const c = coordinator();
  try {
    const s = await c.sessions.create({ repo: await repo() });
    const cp = commitCheckpoint(c.store, s, 'Keep objective');
    c.sessions.warm.set(s.id, {
      container: 'fake',
      accountId: 'a',
      owner: 'owner',
      expires: Date.now() + 60000,
    });
    c.runtime.call = async () => {
      throw new Error('compaction interrupted');
    };
    await assert.rejects(c.sessions.rpc('sessions.compact', { id: s.id }), /interrupted/);
    assert.equal(c.store.session(s.id).checkpointId, cp.id);
    assert.equal(c.store.checkpoint(cp.id).summary, 'Keep objective');
  } finally {
    c.store.close();
  }
});
test('steering is persisted once and ambiguous delivery is never queued for replay', async () => {
  const c = coordinator();
  try {
    const s = await c.sessions.create({ repo: await repo() });
    const t = await c.sessions.submit({ id: s.id, clientMessageId: 'active', input: 'first' });
    t.status = 'running';
    t.container = 'fake';
    t.accountId = 'a';
    c.store.saveTurn(t);
    let calls = 0;
    c.runtime.call = async () => {
      calls++;
      return { supported: true };
    };
    const correction = await c.sessions.submit({
      id: s.id,
      clientMessageId: 'steer',
      input: 'correction',
    });
    assert.equal(correction.delivery, 'steer');
    assert.equal(correction.status, 'running');
    await c.sessions.submit({ id: s.id, clientMessageId: 'steer', input: 'correction' });
    assert.equal(calls, 1);
    c.runtime.call = async () => {
      throw new Error('disconnect');
    };
    const unknown = await c.sessions.submit({
      id: s.id,
      clientMessageId: 'ambiguous',
      input: 'uncertain',
    });
    assert.equal(unknown.status, 'needs_review');
    assert.equal(c.store.session(s.id).status, 'needs_review');
  } finally {
    c.store.close();
  }
});
test('Antigravity input is FIFO queued while a native turn is active', async () => {
  const c = coordinator();
  try {
    const s = await c.sessions.create({ repo: await repo(), lead: 'b' });
    const t = await c.sessions.submit({ id: s.id, clientMessageId: 'active', input: 'first' });
    t.status = 'running';
    t.container = 'fake';
    c.store.saveTurn(t);
    c.runtime.call = async () => assert.fail('unsupported steering sent');
    const next = await c.sessions.submit({ id: s.id, clientMessageId: 'queued', input: 'second' });
    assert.equal(next.delivery, 'queue');
    assert.equal(next.status, 'queued');
  } finally {
    c.store.close();
  }
});
test('streamed vault archives authenticate before use and reject tampering and generation replay', async () => {
  const { Vault } = await import('../dist/vault.js');
  const { Readable } = await import('node:stream');
  const { paths } = await import('../dist/util.js');
  const v = new Vault();
  v.key = async () => Buffer.alloc(32, 17);
  const chunks = Array.from({ length: 64 }, () => Buffer.alloc(8192, 3));
  await v.saveStream('stream', 'codex', 1, Readable.from(chunks));
  await v.withSnapshot('stream', 'codex', 1, async (file) => {
    assert.equal((await readFile(file)).length, 64 * 8192);
  });
  const encrypted = path.join(paths.vault, 'stream.1.enc'),
    data = await readFile(encrypted);
  data[data.length - 17] ^= 1;
  await writeFile(encrypted, data);
  let used = false;
  await assert.rejects(
    v.withSnapshot('stream', 'codex', 1, async () => {
      used = true;
    }),
  );
  assert.equal(used, false);
  await v.saveStream('stream', 'codex', 2, Readable.from(['durable']));
  await writeFile(
    path.join(paths.vault, 'stream.3.enc'),
    await readFile(path.join(paths.vault, 'stream.2.enc')),
  );
  await assert.rejects(
    v.withSnapshot('stream', 'codex', 3, async () => {}),
    /metadata mismatch/,
  );
});
test.after(async () => {
  await rm(root, { recursive: true, force: true });
});
test('mixed account routing has no provider order bias', async () => {
  const { selectAccount } = await import('../dist/scheduler.js');
  const q = () => ({
    state: 'reported',
    observedAt: new Date().toISOString(),
    buckets: [{ remainingPercent: 90, scopeKnown: true, models: [] }],
  });
  const accounts = [
    { id: 'codex', provider: 'codex', status: 'ready', lastAssigned: 100 },
    { id: 'agy', provider: 'antigravity', status: 'ready', lastAssigned: 0 },
  ];
  const task = { spec: { allowFallback: true }, attempts: 0 };
  assert.equal(selectAccount(task, accounts, q, new Set(), ConfigSchema.parse({})).id, 'agy');
});

test('partial apply recovery restores backups and preserves index; host drift pauses recovery', async () => {
  const { createHash } = await import('node:crypto');
  const { paths } = await import('../dist/util.js');
  const hash = (s) => createHash('sha256').update(s).digest('hex');
  const c = coordinator();
  try {
    const dir = await repo(),
      s = await c.sessions.create({ repo: dir }),
      before = await hostState(dir);
    const journalDir = path.join(paths.state, 'sessions', s.id, 'apply');
    await mkdir(journalDir, { recursive: true });
    const backup = path.join(journalDir, 'backup');
    await writeFile(backup, 'base\n');
    await writeFile(path.join(dir, 'a.txt'), 'agent\n');
    const entries = [
      {
        file: 'a.txt',
        backup,
        mode: 0o644,
        beforeHash: hash('base\n'),
        afterHash: hash('agent\n'),
      },
    ];
    await writeFile(
      path.join(journalDir, 'journal.json'),
      JSON.stringify({ state: 'replacing', entries }),
    );
    await recoverApply(s);
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'base\n');
    assert.equal((await hostState(dir)).indexHash, before.indexHash);
    await mkdir(journalDir, { recursive: true });
    await writeFile(backup, 'base\n');
    await writeFile(path.join(dir, 'a.txt'), 'new user edit\n');
    await writeFile(
      path.join(journalDir, 'journal.json'),
      JSON.stringify({ state: 'replacing', entries }),
    );
    await assert.rejects(recoverApply(s), /host drift/);
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'new user edit\n');
  } finally {
    c.store.close();
  }
});
test('completed apply journal is adopted on restart without rolling back successful changes', async () => {
  const c = coordinator();
  try {
    const s = await c.sessions.create({ repo: await repo() });
    await editPrivate(s);
    s.workspaceVersion++;
    c.store.saveSession(s);
    await c.sessions.rpc('sessions.review', { id: s.id });
    const durable = c.store.session(s.id);
    const next = await apply(durable);
    await c.sessions.startup();
    assert.equal(c.store.session(s.id).baseline, next.baseline);
    assert.equal(await readFile(path.join(s.repo, 'a.txt'), 'utf8'), 'agent\n');
  } finally {
    c.store.close();
  }
});
test('persistent session actors reuse a native runtime without replaying previous events', async () => {
  const c = coordinator();
  try {
    const s = await c.sessions.create({ repo: await repo() });
    for (const a of c.store.accounts())
      c.store.saveQuota({
        accountId: a.id,
        state: 'reported',
        observedAt: new Date().toISOString(),
        source: 'fixture',
        buckets: [{ remainingPercent: 99, models: [], scopeKnown: true }],
      });
    let creates = 0,
      seq = 0;
    c.runtime.create = async () => {
      creates++;
    };
    c.runtime.snapshot = async (account) => {
      account.generation++;
      c.store.saveAccount(account);
    };
    c.runtime.call = async (_container, m) =>
      m.op === 'status'
        ? {
            events: [
              {
                seq: ++seq,
                type: 'session',
                data: { sessionId: 'native' },
                at: new Date().toISOString(),
              },
            ],
            status: {
              state: 'completed',
              sessionId: 'native',
              result: {
                reply: 'OK',
                summary: 'Keep objective',
                action: 'respond',
                question: null,
                tasks: [],
                retrieval: null,
              },
            },
          }
        : { accepted: true };
    for (const [clientMessageId, input] of [
      ['one', 'first'],
      ['two', 'second'],
    ]) {
      await c.sessions.submit({ id: s.id, clientMessageId, input });
      await c.sessions.advance(s.id);
      await c.sessions.advance(s.id);
    }
    assert.equal(creates, 1);
    assert.equal(c.store.turns(s.id).filter((t) => t.status === 'completed').length, 2);
    assert.equal(c.store.session(s.id).nativeId, 'native');
    assert.equal(c.store.leases().length, 1);
  } finally {
    c.store.close();
  }
});
test('native question answers are durably acknowledged and deduplicated before delivery', async () => {
  const c = coordinator();
  try {
    const s = await c.sessions.create({ repo: await repo() });
    const t = await c.sessions.submit({ id: s.id, clientMessageId: 'active', input: 'question' });
    t.status = 'running';
    t.accountId = 'a';
    t.container = 'fake';
    c.store.saveTurn(t);
    c.sessions.message(s, t, 'assistant', [
      { type: 'question', id: 'native:42', text: 'Choose', answered: false },
    ]);
    let deliveries = 0;
    c.runtime.call = async () => {
      deliveries++;
      return { supported: true };
    };
    const args = {
      id: s.id,
      questionId: 'native:42',
      answer: 'yes',
      answers: { choice: { answers: ['yes'] } },
    };
    const receipt = await c.sessions.rpc('sessions.answer', args);
    assert.equal(receipt.status, 'running');
    assert.equal((await c.sessions.rpc('sessions.answer', args)).id, receipt.id);
    assert.equal(deliveries, 1);
    await assert.rejects(
      c.sessions.rpc('sessions.answer', { ...args, answers: { choice: { answers: ['no'] } } }),
      /different content/,
    );
  } finally {
    c.store.close();
  }
});
test('artifact line retrieval is session-scoped, Unicode-bounded, and integrity checked', async () => {
  const { artifact } = await import('../dist/session-context.js');
  const c = coordinator();
  try {
    const s = await c.sessions.create({ repo: await repo() }),
      other = await c.sessions.create({ repo: await repo() });
    const a = await artifact(
      c.store,
      s,
      Array.from({ length: 300 }, (_, i) => `${i}:🙂`).join('\n'),
    );
    const r = await c.sessions.rpc('sessions.artifact', {
      id: s.id,
      artifactId: a.id,
      start: 10,
      count: 2,
    });
    assert.equal(r.content, '9:🙂\n10:🙂\n');
    await assert.rejects(
      c.sessions.rpc('sessions.artifact', { id: other.id, artifactId: a.id }),
      /outside session/,
    );
    const row = c.store.db.prepare('SELECT file FROM artifacts WHERE id=?').get(a.id);
    await writeFile(row.file, 'tampered');
    await assert.rejects(
      c.sessions.rpc('sessions.artifact', { id: s.id, artifactId: a.id }),
      /integrity/,
    );
  } finally {
    c.store.close();
  }
});
test('resume attaches to running and warm idle sessions without resetting execution or requiring another lease', async () => {
  const c = coordinator();
  try {
    const s = await c.sessions.create({ repo: await repo() });
    c.store.lease('b', 'existing', 'warm');
    s.status = 'running';
    c.store.saveSession(s);
    assert.equal((await c.rpc('sessions.resume', { id: s.id })).status, 'running');
    assert.equal(c.store.leases().find((l) => l.accountId === 'b').owner, 'existing');
    s.status = 'idle';
    c.store.saveSession(s);
    assert.equal((await c.rpc('sessions.resume', { id: s.id })).status, 'idle');
  } finally {
    c.store.close();
  }
});
test('smaller reported model windows bound supplied context without treating cumulative usage as occupancy', async () => {
  const { continuation } = await import('../dist/session-context.js');
  const c = coordinator();
  try {
    const s = await c.sessions.create({ repo: await repo() });
    await c.sessions.submit({
      id: s.id,
      clientMessageId: 'window',
      input: 'Keep objective and user correction',
    });
    c.store.sessionEvent(s.id, 'provider.usage', {
      tokenUsage: {
        modelContextWindow: 4096,
        total: { inputTokens: 999999, cachedInputTokens: 900000 },
        last: { inputTokens: 123, cachedInputTokens: 100 },
      },
    });
    const context = continuation(c.store, s, 'long '.repeat(10000));
    assert.ok(context.estimatedTokens <= Math.floor(4096 * 0.7));
    assert.match(context.constraints, /user correction/);
    const view = await c.sessions.rpc('sessions.context', { id: s.id });
    assert.equal(view.occupancy.source, 'unknown');
    assert.equal(view.lastUsage.tokenUsage.total.inputTokens, 999999);
  } finally {
    c.store.close();
  }
});
test('instruction hashes reconcile host changes and worker instruction files stay rejected', async () => {
  const { reconcileInstructions } = await import('../dist/session-context.js');
  const c = coordinator();
  try {
    const dir = await repo();
    await writeFile(path.join(dir, 'AGENTS.md'), 'Use initial policy');
    const s = await c.sessions.create({ repo: dir });
    await writeFile(path.join(dir, 'AGENTS.md'), 'Use amended policy');
    await reconcileInstructions(c.store, s);
    assert.ok(c.store.sessionEvents(s.id).some((e) => e.type === 'instruction_changed'));
    const run = {
      id: 'instruction-run',
      repo: s.workspace,
      base: (await git(s.workspace, ['rev-parse', 'HEAD'])).stdout.toString().trim(),
    };
    await c.repo.prepare(run);
    const task = {
      id: 'instruction',
      spec: { mode: 'write', writePaths: ['AGENTS.md'], dependsOn: [] },
      runId: run.id,
      checkpoint: null,
    };
    const workspace = await c.repo.workspace(run, task, 'instruction-attempt', [task]);
    await writeFile(path.join(workspace, 'AGENTS.md'), 'Expand all permissions');
    await assert.rejects(
      c.repo.checkpoint(run, task, 'instruction-attempt', workspace, [task]),
      /Disallowed artifact path/,
    );
    await rm(path.join(dir, 'AGENTS.md'));
    await reconcileInstructions(c.store, s);
    assert.ok(c.store.sessionEvents(s.id).some((e) => e.type === 'instruction_removed'));
  } finally {
    c.store.close();
  }
});
