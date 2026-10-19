// Real Codex, synthetic history, temporary homes, no login or inference requests.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';
const historyMode = process.argv.includes('--paginated') ? 'paginated' : 'legacy';
const root = await mkdtemp(path.join(tmpdir(), 'principal-native-history-copy-'));
process.env.XDG_STATE_HOME = path.join(root, 'state');
for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_AUTH_JSON'])
  delete process.env[name];
const { detectInstallation } = await import('../dist/management/providers.js');
const { ManagementService } = await import('../dist/management/service.js');
const { ManagementStore } = await import('../dist/management/store.js');
const store = new ManagementStore(':memory:');
try {
  // Use the installed CLI only after checking the exact adapter version.
  const installation = await detectInstallation('codex');
  assert.equal(installation?.version, '0.162.1', 'This smoke check requires Codex 0.162.1');
  const source = { id: 'synthetic-a', tool: 'codex', directory: path.join(root, 'a') };
  const target = { id: 'synthetic-b', tool: 'codex', directory: path.join(root, 'b') };
  for (const p of [source, target]) {
    await mkdir(path.join(p.directory, 'sessions'), { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(p.directory, 'config.toml'),
      'cli_auth_credentials_store="file"\nmodel_provider="openai"\n',
      { mode: 0o600 },
    );
  }
  const id = '019a6e80-0000-7000-8000-000000000001';
  const stamp = '2026-10-10T14:00:00Z';
  const records = [
    {
      type: 'session_meta',
      payload: {
        id,
        history_mode: historyMode,
        timestamp: stamp,
        cwd: root,
        originator: 'codex_cli_rs',
        cli_version: '0.162.1',
        source: 'cli',
        model_provider: 'openai',
      },
    },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
    {
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'Synthetic question',
        images: [],
        local_images: [],
        text_elements: [],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Synthetic question' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'synthetic-call',
        arguments: '{"cmd":"never executed"}',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'synthetic-call',
        output: 'Synthetic stored tool output',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Synthetic answer' }],
      },
    },
    {
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: id, last_agent_message: 'Synthetic answer' },
    },
    {
      type: 'compacted',
      payload: {
        message: 'Synthetic compacted context',
        replacement_history: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Synthetic question' }],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Synthetic answer' }],
          },
        ],
      },
    },
  ];
  const sourceHistory = path.join(source.directory, 'sessions', '2026', '10', '10');
  await mkdir(sourceHistory, { recursive: true, mode: 0o700 });
  const sourceFile = path.join(sourceHistory, `rollout-2026-10-10T14-00-00-${id}.jsonl`);
  await writeFile(
    sourceFile,
    records.map((r) => JSON.stringify({ timestamp: stamp, ...r })).join('\n') + '\n',
    { mode: 0o600 },
  );
  const original = await readFile(sourceFile);
  process.env.CODEX_HOME = source.directory;
  const service = new ManagementService(store, {
    id: 'synthetic',
    platform: 'linux',
    name: 'synthetic',
  });
  service.installations = [installation];
  store.put('profile', {
    ...target,
    label: 'Synthetic A',
    createdAt: new Date().toISOString(),
    auth: 'unknown',
  });
  const preview = await service.rpc('history.native', { targetProfile: target.id });
  assert(
    preview.threads.some((t) => t.nativeId === id),
    'Native history preview must discover the stored synthetic conversation',
  );
  const seeded = await service.rpc('history.seed', {
    targetProfile: target.id,
    sourceDirectory: source.directory,
    nativeId: id,
  });
  const aConversation = store.get('conversation', seeded.entry.conversationId);
  assert.notEqual(aConversation.nativeId, id);
  const aRead = await (
    await import('../dist/management/codex.js')
  ).codexRead(target, installation, [
    { method: 'thread/read', params: { threadId: aConversation.nativeId, includeTurns: false } },
  ]);
  const aFile = aRead[0].thread.path;
  const aBytes = await readFile(aFile);
  assert.deepEqual(
    aBytes.subarray(aBytes.indexOf(10) + 1),
    original.subarray(original.indexOf(10) + 1),
  );
  assert.equal(
    (
      await service.rpc('history.seed', {
        targetProfile: target.id,
        sourceDirectory: source.directory,
        nativeId: id,
      })
    ).alreadyLoaded,
    true,
  );
  const onward = {
    ...target,
    id: 'synthetic-c',
    label: 'Synthetic B',
    directory: path.join(root, 'c'),
  };
  await mkdir(onward.directory, { mode: 0o700 });
  store.put('profile', onward);
  const copied = await service.rpc('history.copy', {
    entry: seeded.entry.id,
    targetProfile: onward.id,
  });
  const result = {
    nativeId: copied.nativeId,
    path: (
      await (
        await import('../dist/management/codex.js')
      ).codexRead(onward, installation, [
        { method: 'thread/read', params: { threadId: copied.nativeId, includeTurns: false } },
      ])
    )[0].thread.path,
  };
  assert.notEqual(result.nativeId, aConversation.nativeId);
  assert.deepEqual(await readFile(aFile), aBytes);
  const bBytes = await readFile(result.path);
  assert.deepEqual(
    bBytes.subarray(bBytes.indexOf(10) + 1),
    original.subarray(original.indexOf(10) + 1),
  );
  assert.notEqual(result.nativeId, id);
  assert.deepEqual(await readFile(sourceFile), original);
  const rows = (await readFile(result.path, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const text of ['Synthetic question', 'Synthetic answer', 'Synthetic stored tool output'])
    assert(JSON.stringify(rows).includes(text));
  assert(
    rows.some(
      (row) => row.type === 'compacted' && row.payload.message === 'Synthetic compacted context',
    ),
  );
  assert(!(await readdir(target.directory)).includes('auth.json'));
  assert(!(await readdir(onward.directory)).includes('auth.json'));
  // Load the copy through the actual native resume protocol, without starting a turn.
  const child = spawn(installation.executable, ['app-server', '--listen', 'stdio://'], {
    cwd: root,
    env: { ...process.env, CODEX_HOME: onward.directory },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: child.stdout });
  const waiting = new Map();
  let next = 0;
  lines.on('line', (line) => {
    const r = JSON.parse(line);
    if (waiting.has(r.id)) {
      const { resolve, reject } = waiting.get(r.id);
      waiting.delete(r.id);
      r.error ? reject(new Error('Native resume failed')) : resolve(r.result);
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const request = ++next;
      waiting.set(request, { resolve, reject });
      child.stdin.write(JSON.stringify({ id: request, method, params }) + '\n');
    });
  const timer = setTimeout(() => {
    for (const pending of waiting.values()) pending.reject(new Error('Native smoke timeout'));
    child.kill('SIGTERM');
  }, 12000);
  try {
    await rpc('initialize', {
      clientInfo: { name: 'principal_history_smoke', version: '0.1.0' },
      capabilities: { experimentalApi: false },
    });
    child.stdin.write('{"method":"initialized"}\n');
    const resumed = await rpc('thread/resume', { threadId: result.nativeId });
    assert.equal(resumed.thread.id, result.nativeId);
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 2000);
    killer.unref();
    child.once('exit', () => clearTimeout(killer));
  }
  assert.deepEqual(await readFile(sourceFile), original);
  console.log(
    `PASS (${historyMode}): installed Codex discovered native history, loaded it into A, copied it into B and resumed B; synthetic messages, tool output and compaction retained, original and A unchanged, no credentials copied or inference requested.`,
  );
} finally {
  store.close();
  await rm(root, { recursive: true, force: true });
}
