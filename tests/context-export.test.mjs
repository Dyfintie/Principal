import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'principal-context-export-test-'));
process.env.XDG_STATE_HOME = path.join(root, 'state');
process.env.XDG_RUNTIME_DIR = path.join(root, 'runtime');

const { initManagementPaths } = await import('../dist/management/paths.js');
await initManagementPaths();
const { ManagementStore } = await import('../dist/management/store.js');
const { ManagementService } = await import('../dist/management/service.js');
const { environment } = await import('../dist/management/paths.js');
const {
  stripBoilerplate,
  parseCodexRollout,
  synthesizeContextHandoff,
  locateCodexRollout,
  saveHandoffDocument,
} = await import('../dist/management/context-export.js');

test.after(async () => rm(root, { recursive: true, force: true }));

test('stripBoilerplate cleans system tags from prompt text', () => {
  const dirty = `
<environment_context>
OS: Linux
</environment_context>
<skills_instructions>
Some instructions
</skills_instructions>
<multi_agent_role>Worker</multi_agent_role>
Fix the lagging issue in DashboardApp
<system_reminder>Be concise</system_reminder>
`;
  const cleaned = stripBoilerplate(dirty);
  assert.equal(cleaned, 'Fix the lagging issue in DashboardApp');
});

test('parseCodexRollout parses messages, commands, errors, and files touched', () => {
  const records = [
    { type: 'session_meta', payload: { id: 'thread-xyz-123', cwd: '/work/project' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: '<environment_context>Linux</environment_context>Refactor the authentication flow',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'write_to_file',
        arguments: JSON.stringify({ TargetFile: '/work/project/src/auth.ts' }),
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        output: 'File written successfully',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'npm test' }),
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        output: 'FAIL: Tests failed with exit code 1',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: 'I updated auth.ts but the test failed. Needs token validation.',
      },
    },
  ];

  const parsed = parseCodexRollout(records);
  assert.equal(parsed.id, 'thread-xyz-123');
  assert.equal(parsed.cwd, '/work/project');
  assert.equal(parsed.userTurns.length, 1);
  assert.equal(parsed.userTurns[0], 'Refactor the authentication flow');
  assert.deepEqual(parsed.filesTouched, ['/work/project/src/auth.ts']);
  assert.equal(parsed.commandsRun.length, 1);
  assert.equal(parsed.commandsRun[0].cmd, 'npm test');
  assert.equal(parsed.commandsRun[0].failed, true);
  assert.ok(parsed.lastError?.includes('Tests failed'));
  assert.ok(parsed.lastAssistantResponse.includes('Needs token validation'));
});

test('synthesizeContextHandoff produces rich markdown and seed prompt', () => {
  const parsed = {
    id: 'thread-xyz-123',
    cwd: '/work/project',
    userTurns: ['Optimize database queries for multi-account'],
    assistantTurns: ['Profiling queries...'],
    commandsRun: [{ cmd: 'sqlite3 test.db ".schema"', failed: false }],
    filesTouched: ['/work/project/src/db.ts'],
    lastAssistantResponse: 'Index added on column session_id.',
    lastError: undefined,
    totalTurns: 1,
  };

  const handoff = synthesizeContextHandoff(parsed, {
    title: 'Codex DB Work',
    targetTool: 'Antigravity',
  });

  assert.ok(handoff.handoffMarkdown.includes('# 🔄 Context Handoff: Codex → Antigravity'));
  assert.ok(handoff.handoffMarkdown.includes('Codex DB Work'));
  assert.ok(handoff.handoffMarkdown.includes('Optimize database queries for multi-account'));
  assert.ok(handoff.handoffMarkdown.includes('`/work/project/src/db.ts`'));
  assert.ok(handoff.handoffMarkdown.includes('sqlite3 test.db ".schema"'));
  assert.ok(handoff.summaryPrompt.includes('I am continuing a task originally started in Codex'));
  assert.ok(handoff.summaryPrompt.includes('Optimize database queries for multi-account'));
});

test('locateCodexRollout and saveHandoffDocument work against disk', async () => {
  const profileDir = path.join(root, 'codex-profile');
  const sessionDir = path.join(profileDir, 'sessions', '2026', '10', '18');
  await mkdir(sessionDir, { recursive: true });

  const rolloutFile = path.join(sessionDir, 'rollout-2026-10-18T00-00-00-test-thread-999.jsonl');
  await writeFile(
    rolloutFile,
    JSON.stringify({ type: 'session_meta', payload: { id: 'test-thread-999', cwd: root } }) + '\n',
  );

  const found = await locateCodexRollout(profileDir, 'test-thread-999');
  assert.equal(found, rolloutFile);

  const saved = await saveHandoffDocument(root, 'test-thread-999', '# Handoff Content');
  assert.ok(saved.endsWith('.principal/context-handoff-test-thr.md'));
  const content = await readFile(saved, 'utf8');
  assert.equal(content, '# Handoff Content');
});

test('service.exportContext exports a session cleanly via RPC/service method', async () => {
  const store = new ManagementStore(':memory:');
  const service = new ManagementService(store, await environment());
  service.installations = [
    {
      tool: 'codex',
      version: '0.163.0',
      executable: '/usr/bin/codex',
      capabilities: {
        launch: { supported: true, confidence: 'official', reason: 'native' },
        history: { supported: true, confidence: 'official', reason: 'native' },
        resume: { supported: true, confidence: 'official', reason: 'native' },
        observer: { supported: true, confidence: 'official', reason: 'native' },
        configurationIsolation: { supported: true, confidence: 'official', reason: 'native' },
      },
    },
  ];

  const profileDir = path.join(root, 'service-codex-profile');
  const sessionDir = path.join(profileDir, 'sessions', '2026', '10', '18');
  await mkdir(sessionDir, { recursive: true });

  const threadId = 'service-export-thread-456';
  const rolloutFile = path.join(sessionDir, `rollout-2026-10-18T01-00-00-${threadId}.jsonl`);
  const records = [
    { type: 'session_meta', payload: { id: threadId, cwd: root } },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: 'Add context export unit tests' },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'write_to_file',
        arguments: JSON.stringify({ TargetFile: path.join(root, 'tests/export.test.js') }),
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: 'Test file created. Ready to run test suite.',
      },
    },
  ];
  await writeFile(rolloutFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // Register profile and conversation in store
  const profile = await service.addProfile({
    tool: 'codex',
    label: 'codex-export-tester',
    directory: profileDir,
    isolated: false,
  });

  const exportResult = await service.exportContext({
    nativeId: threadId,
    profileId: profile.id,
    targetTool: 'antigravity',
    saveToFile: true,
    copyToClipboard: false,
  });

  assert.equal(exportResult.nativeId, threadId);
  assert.equal(exportResult.totalTurns, 1);
  assert.ok(exportResult.summaryPrompt.includes('Add context export unit tests'));
  assert.ok(exportResult.savedPath);
  const fileContent = await readFile(exportResult.savedPath, 'utf8');
  assert.ok(fileContent.includes('# 🔄 Context Handoff: Codex → Antigravity'));
  assert.ok(fileContent.includes('tests/export.test.js'));
});
