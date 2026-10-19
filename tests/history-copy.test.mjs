import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = await mkdtemp(path.join(tmpdir(), 'principal-history-copy-tests-'));
process.env.XDG_STATE_HOME = path.join(root, 'state');
const { copyCodexConversation } = await import('../dist/management/history-copy.js');
const { ManagementStore } = await import('../dist/management/store.js');
const { ManagementService } = await import('../dist/management/service.js');
const { managementPaths } = await import('../dist/management/paths.js');
const id = '019a6e80-0000-7000-8000-000000000001';
const fake = path.join(root, 'codex');
await writeFile(
  fake,
  `#!${process.execPath}
import fs from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';import {createInterface} from 'node:readline';
const home=process.env.CODEX_HOME;
async function files(dir){let out=[];for(const e of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){const f=path.join(dir,e.name);if(e.isDirectory())out.push(...await files(f));else if(e.name.endsWith('.jsonl'))out.push(f)}return out}
createInterface({input:process.stdin}).on('line',async line=>{
 const r=JSON.parse(line);if(r.id===undefined)return;
 try{
 let result={};
 if(r.method==='thread/list'){
  const entries=await files(path.join(home,r.params.archived?'archived_sessions':'sessions'));
  const all=[];
  for(const f of entries){const first=JSON.parse((await fs.readFile(f,'utf8')).split('\\n')[0]);all.push({id:first.payload.id,cwd:first.payload.cwd,name:'Saved native conversation',preview:'PRIVATE-NATIVE-PREVIEW'})}
  const offset=Number(r.params.cursor||0);
  result={data:all.slice(offset,offset+1),nextCursor:offset+1<all.length?String(offset+1):null};
 }
 if(r.method==='thread/read'||r.method==='thread/fork'){
  const entries=[...await files(path.join(home,'sessions')),...await files(path.join(home,'archived_sessions'))];let file,rows;
  for(const f of entries){const records=(await fs.readFile(f,'utf8')).trim().split('\\n').map(JSON.parse);if(records[0].payload.id===r.params.threadId){file=f;rows=records;break}}
  if(!file)throw Error('not found');
  let thread={id:r.params.threadId,path:file,historyMode:await fs.readFile(path.join(home,'history-mode'),'utf8').catch(()=>'legacy'),modelProvider:'openai',status:{type:'notLoaded'},cwd:rows[0].payload.cwd,name:'Saved native conversation'};
  if(r.method==='thread/fork'){
   if(process.env.OPENAI_API_KEY||process.env.CODEX_API_KEY||process.env.CODEX_ACCESS_TOKEN||process.env.CODEX_AUTH_JSON)throw Error('inherited credentials');
   const newId=randomUUID();const dest=path.join(home,'sessions','rollout-'+newId+'.jsonl');
   let copied=[{type:'session_meta',payload:{id:newId}},...rows];
   if(rows.some(x=>x.payload?.type==='DROP-RECORD'))copied=copied.filter(x=>x.payload?.type!=='DROP-RECORD');
   await fs.writeFile(dest,copied.map(x=>JSON.stringify(x)).join('\\n')+'\\n');
   thread={...thread,id:newId,path:dest,forkedFromId:r.params.threadId};
  }
  if(r.method==='thread/read'&&await fs.stat(path.join(home,'reject-copy')).catch(()=>null))throw Error('destination unavailable');
  result={thread};
 }
 console.log(JSON.stringify({id:r.id,result}));
 }catch{console.log(JSON.stringify({id:r.id,error:{code:-32000,message:'fixture failure'}}))}
});
`,
  { mode: 0o700 },
);
const installation = {
  tool: 'codex',
  version: '0.162.1',
  verifiedVersion: true,
  executable: fake,
  capabilities: { configurationIsolation: { supported: true } },
};
async function fixture(recordsExtra = []) {
  const dir = await mkdtemp(path.join(root, 'case-'));
  const source = { id: 'a', tool: 'codex', directory: path.join(dir, 'a') };
  const target = { id: 'b', tool: 'codex', directory: path.join(dir, 'b') };
  await mkdir(path.join(source.directory, 'sessions'), { recursive: true });
  await mkdir(target.directory);
  const rows = [
    { type: 'session_meta', payload: { id, cwd: dir } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Original question' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call-1',
        arguments: '{"cmd":"synthetic"}',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'Original complete tool output',
      },
    },
    { type: 'compacted', payload: { message: 'Original compaction', replacement_history: [] } },
    { type: 'turn_context', payload: { cwd: dir } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Original answer' }],
      },
    },
    ...recordsExtra,
  ];
  const file = path.join(source.directory, 'sessions', `rollout-${id}.jsonl`);
  await writeFile(file, rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
  for (const p of [source, target])
    await writeFile(
      path.join(p.directory, 'auth.json'),
      JSON.stringify({ fixture: `credential-${p.id}` }),
      { mode: 0o600 },
    );
  return { source, target, file, rows, dir };
}
test.after(async () => rm(root, { recursive: true, force: true }));
test('copy preserves full messages, tools, compaction and context with independent IDs and untouched credentials', async () => {
  const f = await fixture();
  const original = await readFile(f.file);
  const aAuth = await readFile(path.join(f.source.directory, 'auth.json'));
  const bAuth = await readFile(path.join(f.target.directory, 'auth.json'));
  const copied = await copyCodexConversation(
    f.source,
    f.target,
    { ...installation, version: '0.162.2' },
    id,
    f.dir,
  );
  assert.notEqual(copied.nativeId, id);
  const rows = (await readFile(copied.path, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.slice(1), f.rows.slice(1));
  const originalBody = original.subarray(original.indexOf(10) + 1);
  const copiedBytes = await readFile(copied.path);
  assert.deepEqual(copiedBytes.subarray(copiedBytes.indexOf(10) + 1), originalBody);
  assert.deepEqual(await readFile(f.file), original);
  assert.deepEqual(await readFile(path.join(f.source.directory, 'auth.json')), aAuth);
  assert.deepEqual(await readFile(path.join(f.target.directory, 'auth.json')), bAuth);
  assert.equal((await stat(copied.path)).mode & 0o777, 0o600);
  await writeFile(copied.path, 'Independent continuation\n', { flag: 'a' });
  assert.deepEqual(await readFile(f.file), original);
  const state = path.join(managementPaths.state);
  assert(!(await readdir(state)).some((x) => x.startsWith('history-copy-')));
});
test('copy fails closed for unknown history modes, unfinished turns, unsupported providers and versions', async () => {
  const f = await fixture();
  await writeFile(path.join(f.source.directory, 'history-mode'), 'unknown-mode');
  await assert.rejects(
    copyCodexConversation(f.source, f.target, installation, id, f.dir),
    /storage format/,
  );
  const active = await fixture([{ type: 'event_msg', payload: { type: 'task_started' } }]);
  await assert.rejects(
    copyCodexConversation(active.source, active.target, installation, id, active.dir),
    /Finish/,
  );
  await assert.rejects(
    copyCodexConversation(f.source, { ...f.target, tool: 'claude' }, installation, id, f.dir),
    /Codex profiles only/,
  );
  await assert.rejects(
    copyCodexConversation(f.source, f.target, { ...installation, version: '0.170.0' }, id, f.dir),
    /0.162.1/,
  );
});
test('copy codex conversation succeeds with verified newer version 0.163.0', async () => {
  const f = await fixture();
  const copied = await copyCodexConversation(
    f.source,
    f.target,
    { ...installation, version: '0.163.0' },
    id,
    f.dir,
  );
  assert.ok(copied.nativeId);
  assert.ok(copied.path);
});
test('copy preserves original bytes even when native fork reserialization drops a stored record', async () => {
  const f = await fixture([
    { type: 'event_msg', payload: { type: 'DROP-RECORD', future_field: 'preserve this' } },
  ]);
  const original = await readFile(f.file);
  const copied = await copyCodexConversation(f.source, f.target, installation, id, f.dir);
  const bytes = await readFile(copied.path);
  assert.deepEqual(
    bytes.subarray(bytes.indexOf(10) + 1),
    original.subarray(original.indexOf(10) + 1),
  );
});
test('destination verification failure removes only the new copy and preserves credentials', async () => {
  const f = await fixture();
  await writeFile(path.join(f.target.directory, 'reject-copy'), '');
  await assert.rejects(
    copyCodexConversation(f.source, f.target, installation, id, f.dir),
    /Codex read failed/,
  );
  async function count(dir) {
    let total = 0;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) total += await count(path.join(dir, e.name));
      else if (e.name.endsWith('.jsonl') || e.name.endsWith('.tmp')) total++;
    }
    return total;
  }
  assert.equal(await count(f.target.directory), 0);
  assert.equal(
    JSON.parse(await readFile(path.join(f.target.directory, 'auth.json'), 'utf8')).fixture,
    'credential-b',
  );
});
test('symlinked destination history is rejected without writing outside the profile', async () => {
  const f = await fixture();
  const outside = path.join(f.dir, 'outside');
  await mkdir(outside);
  await symlink(outside, path.join(f.target.directory, 'sessions'));
  await assert.rejects(
    copyCodexConversation(f.source, f.target, installation, id, f.dir),
    /symlinks/,
  );
  assert.deepEqual(await readdir(outside), []);
});
test('management registry binds copied conversation to the destination profile and keeps the original entry', async () => {
  const f = await fixture();
  const store = new ManagementStore(':memory:');
  const service = new ManagementService(store, {
    id: 'fixture',
    platform: 'linux',
    name: 'fixture',
  });
  service.installations = [installation];
  for (const p of [f.source, f.target])
    store.put('profile', {
      ...p,
      label: p.id,
      createdAt: new Date().toISOString(),
      auth: 'authenticated',
    });
  const project = store.project(f.dir, 'fixture');
  store.put('conversation', {
    id: 'conversation',
    nativeId: id,
    tool: 'codex',
    profileId: 'a',
    projectId: project.id,
  });
  store.put('entry', {
    id: 'original',
    profileId: 'a',
    projectId: project.id,
    folderId: 'unassigned',
    tool: 'codex',
    title: 'Original',
    conversationId: 'conversation',
    createdAt: new Date().toISOString(),
    archivedAt: null,
  });
  const copied = await service.rpc('history.copy', { entry: 'original', targetProfile: 'b' });
  assert.equal(copied.entry.profileId, 'b');
  assert.equal(store.get('entry', 'original').profileId, 'a');
  assert.notEqual(copied.entry.conversationId, 'conversation');
  assert.equal(store.get('conversation', copied.entry.conversationId).nativeId, copied.nativeId);
  store.put('invocation', { id: 'running', entryId: 'original', lifecycle: 'running' });
  await assert.rejects(
    service.rpc('history.copy', { entry: 'original', targetProfile: 'b' }),
    /managed invocation/,
  );
  store.close();
});

async function seedFixture(extra = []) {
  const f = await fixture(extra);
  const store = new ManagementStore(':memory:');
  const service = new ManagementService(store, {
    id: 'fixture',
    platform: 'linux',
    name: 'fixture',
  });
  service.installations = [installation];
  store.put('profile', {
    ...f.target,
    label: 'Profile A',
    createdAt: new Date().toISOString(),
    auth: 'authenticated',
  });
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = f.source.directory;
  return {
    ...f,
    store,
    service,
    close() {
      store.close();
      if (before === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = before;
    },
  };
}
test('native history hydrates an empty profile, preserves login, deduplicates and can be copied onward into B', async () => {
  const f = await seedFixture();
  try {
    const original = await readFile(f.file);
    const auth = await readFile(path.join(f.target.directory, 'auth.json'));
    await writeFile(path.join(f.target.directory, 'config.toml'), 'fixture configuration');
    const preview = await f.service.rpc('history.native', { targetProfile: 'b' });
    assert.equal(preview.sourceDirectory, f.source.directory);
    assert.equal(preview.threads.length, 1);
    assert.equal(preview.threads[0].alreadyLoaded, false);
    assert(!JSON.stringify(preview).includes('PRIVATE-NATIVE-PREVIEW'));
    assert.equal(f.store.profiles().length, 1, 'Source history does not enroll its account');
    const request = { targetProfile: 'b', sourceDirectory: f.source.directory, nativeId: id };
    const seeded = await f.service.rpc('history.seed', request);
    assert.equal(seeded.entry.profileId, 'b');
    const conversation = f.store.get('conversation', seeded.entry.conversationId);
    assert.notEqual(conversation.nativeId, id);
    assert.deepEqual(conversation.seededFrom, { directory: f.source.directory, nativeId: id });
    assert.deepEqual(await readFile(f.file), original);
    assert.deepEqual(await readFile(path.join(f.target.directory, 'auth.json')), auth);
    assert.equal(
      await readFile(path.join(f.target.directory, 'config.toml'), 'utf8'),
      'fixture configuration',
    );
    assert.equal((await f.service.rpc('history.seed', request)).alreadyLoaded, true);
    assert.equal(f.store.list('entry').length, 1);
    assert.equal(
      (await f.service.rpc('history.native', { targetProfile: 'b' })).threads[0].alreadyLoaded,
      true,
    );
    const b = { ...f.target, id: 'c', label: 'Profile B', directory: path.join(f.dir, 'c') };
    await mkdir(b.directory);
    f.store.put('profile', b);
    const copied = await f.service.rpc('history.copy', {
      entry: seeded.entry.id,
      targetProfile: 'c',
    });
    assert.equal(copied.entry.profileId, 'c');
    assert.notEqual(copied.nativeId, conversation.nativeId);
    assert.deepEqual(await readFile(f.file), original);
    assert.equal(f.store.list('entry').length, 2);
  } finally {
    f.close();
  }
});
test('native history preview paginates, includes archived history and never persists message previews', async () => {
  const f = await seedFixture();
  try {
    const secondId = '019a6e80-0000-7000-8000-000000000002';
    const rows = [
      { type: 'session_meta', payload: { id: secondId, cwd: f.dir } },
      ...f.rows.slice(1),
    ];
    await writeFile(
      path.join(f.source.directory, 'sessions', 'second.jsonl'),
      rows.map(JSON.stringify).join('\n') + '\n',
    );
    const page1 = await f.service.rpc('history.native', { targetProfile: 'b' });
    assert.equal(page1.threads.length, 1);
    assert.equal(page1.nextCursor, '1');
    const page2 = await f.service.rpc('history.native', {
      targetProfile: 'b',
      cursor: page1.nextCursor,
    });
    assert.equal(page2.nextCursor, null);
    assert.notEqual(page2.threads[0].nativeId, page1.threads[0].nativeId);
    await mkdir(path.join(f.source.directory, 'archived_sessions'));
    await writeFile(
      path.join(f.source.directory, 'archived_sessions', 'archived.jsonl'),
      rows.map(JSON.stringify).join('\n') + '\n',
    );
    const archived = await f.service.rpc('history.native', { targetProfile: 'b', archived: true });
    assert.equal(archived.threads[0].nativeId, secondId);
    assert.equal(f.store.list('entry').length, 0, 'Preview does not hydrate');
    assert.equal(f.store.list('conversation').length, 0);
    const seeded = await f.service.rpc('history.seed', {
      targetProfile: 'b',
      sourceDirectory: f.source.directory,
      nativeId: secondId,
    });
    assert.equal(seeded.alreadyLoaded, false);
  } finally {
    f.close();
  }
});
test('unfinished native history is skipped without changing login and can be loaded after completion', async () => {
  const f = await seedFixture([{ type: 'event_msg', payload: { type: 'task_started' } }]);
  try {
    const request = { targetProfile: 'b', sourceDirectory: f.source.directory, nativeId: id };
    await assert.rejects(f.service.rpc('history.seed', request), /Finish/);
    assert.equal(f.store.list('entry').length, 0);
    assert.deepEqual(await readdir(f.target.directory), ['auth.json']);
    await writeFile(
      f.file,
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n',
      { flag: 'a' },
    );
    assert.equal((await f.service.rpc('history.seed', request)).alreadyLoaded, false);
  } finally {
    f.close();
  }
});
test('native history rejects the same home, changed source and unsupported versions', async () => {
  const f = await seedFixture();
  try {
    await assert.rejects(
      f.service.rpc('history.seed', { targetProfile: 'b', sourceDirectory: f.dir, nativeId: id }),
      /location changed/,
    );
    process.env.CODEX_HOME = f.target.directory;
    await assert.rejects(
      f.service.rpc('history.native', { targetProfile: 'b' }),
      /already uses native history/,
    );
    process.env.CODEX_HOME = f.source.directory;
    f.service.installations = [{ ...installation, version: '0.170.0' }];
    await assert.rejects(f.service.rpc('history.native', { targetProfile: 'b' }), /0.162.1/);
  } finally {
    f.close();
  }
});

test('overlapping native loads cannot duplicate the destination conversation', async () => {
  const f = await seedFixture();
  try {
    const request = { targetProfile: 'b', sourceDirectory: f.source.directory, nativeId: id };
    const outcomes = await Promise.allSettled([
      f.service.rpc('history.seed', request),
      f.service.rpc('history.seed', request),
    ]);
    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
    assert.match(
      outcomes.find((o) => o.status === 'rejected').reason.message,
      /already in progress/,
    );
    assert.equal(f.store.list('entry').length, 1);
  } finally {
    f.close();
  }
});
test('native loading respects managed source invocations and unavailable project directories', async () => {
  const f = await seedFixture();
  try {
    f.store.put('profile', {
      ...f.source,
      label: 'Native',
      createdAt: new Date().toISOString(),
      auth: 'authenticated',
    });
    const project = f.store.project(f.dir, 'fixture');
    f.store.put('conversation', {
      id: 'native-conversation',
      nativeId: id,
      profileId: 'a',
      tool: 'codex',
      projectId: project.id,
    });
    f.store.put('entry', {
      id: 'native-entry',
      conversationId: 'native-conversation',
      profileId: 'a',
    });
    f.store.put('invocation', {
      id: 'native-running',
      entryId: 'native-entry',
      lifecycle: 'running',
    });
    const request = { targetProfile: 'b', sourceDirectory: f.source.directory, nativeId: id };
    await assert.rejects(f.service.rpc('history.seed', request), /managed invocation/);
    f.store.put('invocation', {
      id: 'native-running',
      entryId: 'native-entry',
      lifecycle: 'exited',
    });
    const rows = [...f.rows];
    rows[0] = {
      ...rows[0],
      payload: { ...rows[0].payload, cwd: path.join(f.dir, 'missing-project') },
    };
    await writeFile(f.file, rows.map(JSON.stringify).join('\n') + '\n');
    await assert.rejects(
      f.service.rpc('history.seed', request),
      /project directory no longer exists/,
    );
    assert.deepEqual(await readdir(f.target.directory), ['auth.json']);
  } finally {
    f.close();
  }
});

test('paginated local rollouts load into A and retain every body byte when copied onward into B', async () => {
  const f = await seedFixture([
    { type: 'event_msg', payload: { type: 'DROP-RECORD', future_field: { preserved: true } } },
  ]);
  try {
    const rows = f.rows.map((r, i) =>
      i === 0 ? { ...r, payload: { ...r.payload, history_mode: 'paginated' } } : r,
    );
    await writeFile(f.file, rows.map(JSON.stringify).join('\n') + '\n');
    await writeFile(path.join(f.source.directory, 'history-mode'), 'paginated');
    const original = await readFile(f.file);
    const seeded = await f.service.rpc('history.seed', {
      targetProfile: 'b',
      sourceDirectory: f.source.directory,
      nativeId: id,
    });
    const b = { ...f.target, id: 'c', label: 'Profile B', directory: path.join(f.dir, 'c') };
    await mkdir(b.directory);
    f.store.put('profile', b);
    const copy = await f.service.rpc('history.copy', {
      entry: seeded.entry.id,
      targetProfile: 'c',
    });
    async function find(dir, nativeId) {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, item.name);
        if (item.isDirectory()) {
          const found = await find(file, nativeId);
          if (found) return found;
        } else if (item.name.endsWith('.jsonl')) {
          const bytes = await readFile(file);
          if (JSON.parse(bytes.toString().split('\n')[0]).payload.id === nativeId) return bytes;
        }
      }
    }
    const aId = f.store.get('conversation', seeded.entry.conversationId).nativeId;
    for (const [home, nativeId] of [
      [f.target.directory, aId],
      [b.directory, copy.nativeId],
    ]) {
      const bytes = await find(home, nativeId);
      assert.deepEqual(
        bytes.subarray(bytes.indexOf(10) + 1),
        original.subarray(original.indexOf(10) + 1),
      );
    }
    assert.notEqual(aId, id);
    assert.notEqual(copy.nativeId, aId);
    assert.deepEqual(await readFile(f.file), original);
    assert.equal(
      JSON.parse(await readFile(path.join(f.target.directory, 'auth.json'), 'utf8')).fixture,
      'credential-b',
    );
  } finally {
    f.close();
  }
});
test('paginated metadata mismatch fails without publishing or replacing credentials', async () => {
  const f = await fixture();
  await writeFile(path.join(f.source.directory, 'history-mode'), 'paginated');
  await assert.rejects(
    copyCodexConversation(f.source, f.target, installation, id, f.dir),
    /metadata does not match/,
  );
  assert.deepEqual(await readdir(f.target.directory), ['auth.json']);
});
