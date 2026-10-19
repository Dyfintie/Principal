import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = await mkdtemp(path.join(tmpdir(), 'principal-shared-history-test-'));
process.env.XDG_STATE_HOME = path.join(root, 'state');
process.env.XDG_RUNTIME_DIR = path.join(root, 'runtime');
process.env.ANTIGRAVITY_HOME = path.join(root, 'system-gemini', 'antigravity-cli');

const { initManagementPaths } = await import('../dist/management/paths.js');
await initManagementPaths();
const { ManagementStore } = await import('../dist/management/store.js');
const { ManagementService } = await import('../dist/management/service.js');
const { environment } = await import('../dist/management/paths.js');
const { ensureSharedHistory } = await import('../dist/management/shared-history.js');
const { antigravityHistory } = await import('../dist/management/antigravity-history.js');

const summarySql = `CREATE TABLE IF NOT EXISTS conversation_summaries(conversation_id TEXT PRIMARY KEY,title TEXT,preview TEXT,step_count INTEGER,last_modified_time datetime,workspace_uris TEXT,status TEXT,source TEXT,project_id TEXT,agent_name TEXT,parent_conversation_id TEXT,nesting_depth INTEGER,battle_id TEXT,winning_conversation_id TEXT,not_fully_idle numeric,killed numeric,last_user_input_time datetime,last_user_input_step_index INTEGER,app_data_dir TEXT,raw_summary BLOB,group_id TEXT)`;

const installation = {
  tool: 'antigravity',
  version: '1.3.3',
  executable: '/usr/bin/agy',
  capabilities: {
    launch: { supported: true, confidence: 'official', reason: 'native' },
    history: { supported: true, confidence: 'official', reason: 'native' },
    resume: { supported: true, confidence: 'official', reason: 'native' },
    observer: { supported: true, confidence: 'official', reason: 'native' },
    configurationIsolation: { supported: true, confidence: 'official', reason: 'native' },
  },
};

test.after(async () => rm(root, { recursive: true, force: true }));

test('Account A1 and A2 share common system conversation history with immediate cross-account visibility and zero copies', async () => {
  const store = new ManagementStore(':memory:');
  const service = new ManagementService(store, await environment());
  service.installations = [installation];

  // Initialize two isolated profiles representing Account A1 and Account A2
  const a1 = await service.addProfile({ tool: 'antigravity', label: 'account-a1', isolated: true });
  const a2 = await service.addProfile({ tool: 'antigravity', label: 'account-a2', isolated: true });

  assert.ok(a1);
  assert.ok(a2);
  assert.notEqual(a1.id, a2.id);
  assert.notEqual(a1.directory, a2.directory);

  // Link both to shared common history
  await ensureSharedHistory(a1, installation);
  await ensureSharedHistory(a2, installation);

  // Verify that conversations directory and summaries in both profiles are symlinked to common system directory
  const sysConversationsDir = path.join(process.env.ANTIGRAVITY_HOME, 'conversations');
  const a1ConversationsLink = path.join(a1.directory, 'conversations');
  const a2ConversationsLink = path.join(a2.directory, 'conversations');

  assert.equal(await realpath(a1ConversationsLink), await realpath(sysConversationsDir));
  assert.equal(await realpath(a2ConversationsLink), await realpath(sysConversationsDir));

  // Initialize common conversation_summaries.db in system directory
  const sysDbPath = path.join(process.env.ANTIGRAVITY_HOME, 'conversation_summaries.db');
  const sysDb = new Database(sysDbPath);
  sysDb.exec(summarySql);
  sysDb.close();

  // Re-ensure shared links for db
  await ensureSharedHistory(a1, installation);
  await ensureSharedHistory(a2, installation);

  const a1DbLink = path.join(a1.directory, 'conversation_summaries.db');
  const a2DbLink = path.join(a2.directory, 'conversation_summaries.db');
  assert.equal(await realpath(a1DbLink), await realpath(sysDbPath));
  assert.equal(await realpath(a2DbLink), await realpath(sysDbPath));

  // Step 1: Account A1 creates and writes to conversation C1
  const convId1 = '11111111-aaaa-4111-8111-111111111111';
  const a1Db = new Database(a1DbLink);
  a1Db
    .prepare(
      'INSERT INTO conversation_summaries(conversation_id,title,workspace_uris,not_fully_idle,app_data_dir,raw_summary) VALUES(?,?,?,?,?,?)',
    )
    .run(convId1, 'Conversation from Account A1', JSON.stringify([pathToFileURL(root).href]), 0, 'antigravity-cli', Buffer.from([1, 2, 3]));
  a1Db.close();

  // Create conversation 1 DB file through A1's conversations path
  const c1File = path.join(a1ConversationsLink, convId1 + '.db');
  await writeFile(c1File, 'conversation-1-sqlite-data');

  // Step 2: Account A2 immediately reads history and sees C1!
  const a2History = await antigravityHistory(a2, installation);
  assert.equal(a2History.length, 1);
  assert.equal(a2History[0].nativeId, convId1);
  assert.equal(a2History[0].title, 'Conversation from Account A1');

  // Also verify file is directly accessible through A2's conversations link
  const c1FromA2 = await readFile(path.join(a2ConversationsLink, convId1 + '.db'), 'utf8');
  assert.equal(c1FromA2, 'conversation-1-sqlite-data');

  // Step 3: Account A2 creates and writes to conversation C2
  const convId2 = '22222222-bbbb-4222-8222-222222222222';
  const a2Db = new Database(a2DbLink);
  a2Db
    .prepare(
      'INSERT INTO conversation_summaries(conversation_id,title,workspace_uris,not_fully_idle,app_data_dir,raw_summary) VALUES(?,?,?,?,?,?)',
    )
    .run(convId2, 'Conversation from Account A2', JSON.stringify([pathToFileURL(root).href]), 0, 'antigravity-cli', Buffer.from([4, 5, 6]));
  a2Db.close();

  // Create conversation 2 DB file through A2's conversations path
  const c2File = path.join(a2ConversationsLink, convId2 + '.db');
  await writeFile(c2File, 'conversation-2-sqlite-data');

  // Step 4: Account A1 immediately reads history and sees BOTH C1 and C2!
  const a1History = await antigravityHistory(a1, installation);
  assert.equal(a1History.length, 2);
  const ids = a1History.map((h) => h.nativeId).sort();
  assert.deepEqual(ids, [convId1, convId2].sort());

  // Step 5: Verify both conversation files exist as distinct files in the shared system directory
  const sysFiles = await readdir(sysConversationsDir);
  assert.ok(sysFiles.includes(convId1 + '.db'));
  assert.ok(sysFiles.includes(convId2 + '.db'));

  store.close();
});
