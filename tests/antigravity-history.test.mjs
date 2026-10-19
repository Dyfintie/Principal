import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = await mkdtemp(path.join(tmpdir(), 'principal-agy-history-'));
process.env.XDG_STATE_HOME = path.join(root, 'state');
process.env.XDG_RUNTIME_DIR = path.join(root, 'runtime');
const { managementPaths, initManagementPaths, environment } =
  await import('../dist/management/paths.js');
await initManagementPaths();
const { copyAntigravityConversation, antigravityHistory } =
  await import('../dist/management/antigravity-history.js');
const { ManagementStore } = await import('../dist/management/store.js');
const { ManagementService } = await import('../dist/management/service.js');
const { processIdentity } = await import('../dist/management/process.js');
const cap = { supported: true, confidence: 'unverified', reason: 'fixture' };
const installation = {
  tool: 'antigravity',
  version: '1.3.3',
  executable: path.join(root, 'fake-agy'),
  capabilities: {
    launch: cap,
    history: cap,
    configurationIsolation: cap,
    observer: cap,
    resources: { ...cap, supported: false },
  },
};
const summarySql = `CREATE TABLE IF NOT EXISTS conversation_summaries(conversation_id TEXT PRIMARY KEY,title TEXT,preview TEXT,step_count INTEGER,last_modified_time datetime,workspace_uris TEXT,status TEXT,source TEXT,project_id TEXT,agent_name TEXT,parent_conversation_id TEXT,nesting_depth INTEGER,battle_id TEXT,winning_conversation_id TEXT,not_fully_idle numeric,killed numeric,last_user_input_time datetime,last_user_input_step_index INTEGER,app_data_dir TEXT,raw_summary BLOB,group_id TEXT)`;
const nativeId = '11111111-1111-4111-8111-111111111111';
async function seed(profile, id = nativeId) {
  await mkdir(path.join(profile.directory, 'conversations'), { recursive: true });
  const summary = new Database(path.join(profile.directory, 'conversation_summaries.db'));
  summary.exec(summarySql);
  summary
    .prepare(
      'INSERT INTO conversation_summaries(conversation_id,title,workspace_uris,not_fully_idle,app_data_dir,raw_summary) VALUES(?,?,?,?,?,?)',
    )
    .run(
      id,
      'Synthetic history',
      JSON.stringify([pathToFileURL(root).href]),
      0,
      'antigravity-cli',
      Buffer.from([0, 255, 1]),
    );
  summary.close();
  const db = new Database(path.join(profile.directory, 'conversations', id + '.db'));
  db.exec(
    `CREATE TABLE trajectory_meta(trajectory_id TEXT,cascade_id TEXT);CREATE TABLE steps(idx INTEGER,status INTEGER,has_subtrajectory INTEGER,step_payload BLOB);CREATE TABLE gen_metadata(idx INTEGER,data BLOB);CREATE TABLE executor_metadata(idx INTEGER,data BLOB);CREATE TABLE parent_references(idx INTEGER,data BLOB);CREATE TABLE trajectory_metadata_blob(id TEXT,data BLOB);CREATE TABLE battle_mode_infos(idx INTEGER,data BLOB);`,
  );
  db.prepare('INSERT INTO trajectory_meta VALUES(?,?)').run('internal-trajectory', id);
  for (const table of ['steps', 'gen_metadata', 'executor_metadata', 'trajectory_metadata_blob']) {
    if (table === 'steps')
      db.prepare('INSERT INTO steps VALUES(?,?,?,?)').run(1, 3, 0, Buffer.from([0, 1, 255, 100]));
    else
      db.prepare('INSERT INTO ' + table + ' VALUES(?,?)').run(
        table === 'trajectory_metadata_blob' ? 'native-metadata' : 1,
        Buffer.from('OPAQUE-' + table),
      );
  }
  db.close();
}
async function fixture() {
  const store = new ManagementStore(':memory:');
  const service = new ManagementService(store, await environment());
  service.installations = [installation];
  const a = await service.addProfile({ tool: 'antigravity', label: 'a', isolated: true }),
    b = await service.addProfile({ tool: 'antigravity', label: 'b', isolated: true });
  await seed(a);
  return { store, service, a, b };
}
test.after(async () => rm(root, { recursive: true, force: true }));

test('Antigravity local copy preserves opaque records and native IDs with independent storage and untouched logins', async () => {
  const { store, service, a, b } = await fixture();
  try {
    for (const p of [a, b])
      await writeFile(path.join(p.directory, 'auth.json'), p.label + '-PRIVATE-LOGIN');
    const source = path.join(a.directory, 'conversations', nativeId + '.db');
    const before = await readFile(source);
    const imported = await service.history({ profile: a.id });
    assert.equal(imported.imported.length, 1);
    const copied = await service.copyHistory({
      entry: imported.imported[0].id,
      targetProfile: b.id,
    });
    assert.equal(copied.nativeId, nativeId);
    assert.equal(copied.nativeResumeVerified, false);
    assert.equal(
      store.require('conversation', copied.entry.conversationId).nativeResumeVerified,
      false,
    );
    const dest = path.join(b.directory, 'conversations', nativeId + '.db');
    const db = new Database(dest);
    assert.deepEqual(
      db.prepare('SELECT step_payload FROM steps').get().step_payload,
      Buffer.from([0, 1, 255, 100]),
    );
    for (const table of ['gen_metadata', 'executor_metadata', 'trajectory_metadata_blob'])
      assert.deepEqual(
        db.prepare('SELECT data FROM ' + table).get().data,
        Buffer.from('OPAQUE-' + table),
      );
    db.prepare('UPDATE steps SET step_payload=?').run(Buffer.from('B-NEW-TURN'));
    db.close();
    assert.deepEqual(await readFile(source), before);
    const sourceDb = new Database(source);
    sourceDb.prepare('UPDATE steps SET step_payload=?').run(Buffer.from('A-NEW-TURN'));
    sourceDb.close();
    const targetDb = new Database(dest, { readonly: true });
    assert.equal(
      targetDb.prepare('SELECT step_payload FROM steps').get().step_payload.toString(),
      'B-NEW-TURN',
    );
    targetDb.close();
    for (const p of [a, b])
      assert.equal(
        await readFile(path.join(p.directory, 'auth.json'), 'utf8'),
        p.label + '-PRIVATE-LOGIN',
      );
    assert.equal((await antigravityHistory(b, installation)).length, 1);
    const preview = await service.antigravityHistoryPreview({
      sourceProfile: a.id,
      targetProfile: b.id,
    });
    assert.equal(preview.threads[0].alreadyLoaded, true);
    const repeated = await service.loadAntigravityHistory({
      sourceProfile: a.id,
      targetProfile: b.id,
      experimental: true,
    });
    assert.equal(repeated.alreadyLoaded, 1);
    assert.equal(repeated.copied, 0);
    await assert.rejects(copyAntigravityConversation(a, b, installation, nativeId), /already has/);
  } finally {
    store.close();
  }
});

test('Antigravity copies reject active profiles, dependencies and unsafe paths while allowing structurally compatible versions', async () => {
  const { store, service, a, b } = await fixture();
  try {
    const imported = await service.history({ profile: a.id });
    const wrapper = await processIdentity(process.pid);
    await service.prepare({ profile: b.id, directory: root, wrapper });
    await assert.rejects(
      service.copyHistory({ entry: imported.imported[0].id, targetProfile: b.id }),
      /both Antigravity profiles/,
    );
    assert.equal(
      (await antigravityHistory(a, { ...installation, version: '1.3.99' }))[0].nativeId,
      nativeId,
    );
    const file = path.join(a.directory, 'conversations', nativeId + '.db');
    const db = new Database(file);
    db.prepare('INSERT INTO parent_references VALUES(?,?)').run(1, Buffer.from('unknown-child'));
    db.close();
    await assert.rejects(
      copyAntigravityConversation(a, b, installation, nativeId),
      /dependent trajectories/,
    );
    const clean = new Database(file);
    clean.exec('DELETE FROM parent_references');
    clean.close();
    await symlink(
      path.join(root, 'untrusted-history'),
      path.join(b.directory, 'conversations', nativeId + '.db'),
    );
    await assert.rejects(copyAntigravityConversation(a, b, installation, nativeId), /already has/);
    await assert.rejects(
      copyAntigravityConversation(a, { ...b, isolated: false }, installation, nativeId),
      /isolated/,
    );
  } finally {
    store.close();
  }
});

test('future Antigravity versions still reject unknown storage contracts', async () => {
  const { store, a } = await fixture();
  try {
    const db = new Database(path.join(a.directory, 'conversation_summaries.db'));
    db.exec('ALTER TABLE conversation_summaries ADD COLUMN future_payload TEXT');
    db.close();
    await assert.rejects(
      antigravityHistory(a, { ...installation, version: '2.0.0' }),
      /Unsupported Antigravity summary schema/,
    );
  } finally {
    store.close();
  }
});

test('Antigravity batch hydration includes committed WAL records and refuses summary dependencies without publishing partial conversations', async () => {
  const { store, service, a, b } = await fixture();
  try {
    const file = path.join(a.directory, 'conversations', nativeId + '.db');
    const writer = new Database(file);
    writer.pragma('journal_mode=WAL');
    writer.pragma('wal_autocheckpoint=0');
    writer
      .prepare('INSERT INTO steps VALUES(?,?,?,?)')
      .run(2, 3, 0, Buffer.from('committed-WAL-record'));
    const result = await service.loadAntigravityHistory({
      sourceProfile: a.id,
      targetProfile: b.id,
      experimental: true,
    });
    assert.equal(result.copied, 1);
    assert.deepEqual(result.failures, []);
    const target = new Database(path.join(b.directory, 'conversations', nativeId + '.db'), {
      readonly: true,
    });
    assert.equal(
      target.prepare('SELECT step_payload FROM steps WHERE idx=2').get().step_payload.toString(),
      'committed-WAL-record',
    );
    target.close();
    writer.close();
    const c = await service.addProfile({ tool: 'antigravity', label: 'c', isolated: true });
    const summary = new Database(path.join(a.directory, 'conversation_summaries.db'));
    summary
      .prepare('UPDATE conversation_summaries SET parent_conversation_id=?')
      .run('dependent-parent');
    summary.close();
    await assert.rejects(
      copyAntigravityConversation(a, c, installation, nativeId),
      /parent conversation is missing/,
    );
    await assert.rejects(
      readFile(path.join(c.directory, 'conversations', nativeId + '.db')),
      /ENOENT/,
    );
    await assert.rejects(readFile(path.join(c.directory, 'conversation_summaries.db')), /ENOENT/);
    await symlink(
      path.join(root, 'untrusted-wal'),
      path.join(a.directory, 'conversation_summaries.db-wal'),
    );
    await assert.rejects(antigravityHistory(a, installation), /History file must be regular/);
  } finally {
    store.close();
  }
});

test('Antigravity parent-linked histories copy their ancestors first and preserve independent native parent links', async () => {
  const { store, service, a, b } = await fixture();
  const child = '22222222-2222-4222-8222-222222222222';
  try {
    await seed(a, child);
    const summary = new Database(path.join(a.directory, 'conversation_summaries.db'));
    summary
      .prepare(
        'UPDATE conversation_summaries SET parent_conversation_id=?,last_modified_time=? WHERE conversation_id=?',
      )
      .run(nativeId, '2026-10-11', child);
    summary.close();
    const result = await service.loadAntigravityHistory({
      sourceProfile: a.id,
      targetProfile: b.id,
      experimental: true,
    });
    assert.equal(result.copied, 2);
    assert.equal(result.alreadyLoaded, 0);
    assert.deepEqual(result.failures, []);
    const target = new Database(path.join(b.directory, 'conversation_summaries.db'), {
      readonly: true,
    });
    assert.equal(
      target
        .prepare(
          'SELECT parent_conversation_id FROM conversation_summaries WHERE conversation_id=?',
        )
        .get(child).parent_conversation_id,
      nativeId,
    );
    target.close();
    assert.equal(store.list('conversation').filter((c) => c.profileId === b.id).length, 2);
    const original = new Database(path.join(a.directory, 'conversation_summaries.db'));
    original
      .prepare('UPDATE conversation_summaries SET parent_conversation_id=? WHERE conversation_id=?')
      .run(child, nativeId);
    original.close();
    const c = await service.addProfile({ tool: 'antigravity', label: 'cycle', isolated: true });
    await assert.rejects(copyAntigravityConversation(a, c, installation, child), /Cyclic parent/);
  } finally {
    store.close();
  }
});

test('Antigravity retains history for deleted workspaces and never counts missing destination files as loaded', async () => {
  const { store, service, a, b } = await fixture();
  try {
    const summary = new Database(path.join(a.directory, 'conversation_summaries.db'));
    summary
      .prepare('UPDATE conversation_summaries SET workspace_uris=?')
      .run(JSON.stringify([pathToFileURL(path.join(root, 'deleted-workspace')).href]));
    summary.close();
    const loaded = await service.loadAntigravityHistory({
      sourceProfile: a.id,
      targetProfile: b.id,
      experimental: true,
    });
    assert.equal(loaded.copied, 1);
    assert.deepEqual(loaded.failures, []);
    await rm(path.join(b.directory, 'conversations', nativeId + '.db'));
    const preview = await service.antigravityHistoryPreview({
      sourceProfile: a.id,
      targetProfile: b.id,
    });
    assert.equal(preview.threads[0].alreadyLoaded, false);
    const retried = await service.loadAntigravityHistory({
      sourceProfile: a.id,
      targetProfile: b.id,
      experimental: true,
    });
    assert.equal(retried.alreadyLoaded, 0);
    assert.equal(retried.failures.length, 1);
    assert.match(retried.failures[0], /not counted as loaded/);
  } finally {
    store.close();
  }
});

test('Antigravity copies local SQLite history larger than the old 64 MiB cap without reading its payload into memory', async () => {
  const { store, service, a, b } = await fixture();
  try {
    const db = new Database(path.join(a.directory, 'conversations', nativeId + '.db'));
    db.prepare('UPDATE steps SET step_payload=zeroblob(?)').run(65 * 1024 * 1024);
    db.close();
    const result = await service.loadAntigravityHistory({
      sourceProfile: a.id,
      targetProfile: b.id,
      experimental: true,
    });
    assert.equal(result.copied, 1);
    assert.deepEqual(result.failures, []);
    const dest = new Database(path.join(b.directory, 'conversations', nativeId + '.db'), {
      readonly: true,
    });
    assert.equal(
      dest.prepare('SELECT length(step_payload) n FROM steps').get().n,
      65 * 1024 * 1024,
    );
    dest.close();
  } finally {
    store.close();
  }
});
