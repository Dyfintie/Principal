import Database from 'better-sqlite3';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  inventoryAccounts,
  inventoryUsage,
  cachedEnrolledUsage,
  providerUsage,
  profileInventory,
  usageTools,
} from '../dist/unified-inventory.js';

const now = Date.parse('2026-10-10T12:00:00Z');
const native = {
  profiles: [
    {
      id: 'native-codex',
      tool: 'codex',
      label: 'existing-codex',
      directory: '/fixture/codex',
      auth: 'authenticated',
      authObservedAt: '2026-10-10T11:59:00Z',
      reportedAccount: 'native@example.test',
    },
    {
      id: 'native-agy',
      tool: 'antigravity',
      label: 'existing-agy',
      directory: '/fixture/agy',
      auth: 'unknown',
      authObservedAt: null,
      reportedAccount: null,
    },
  ],
  installations: [
    {
      tool: 'antigravity',
      capabilities: { resources: { reason: 'Statusline observer required' } },
    },
  ],
  resources: [
    {
      profileId: 'native-codex',
      bucket: 'five-hour',
      metric: 'rate-limit-used',
      value: 25,
      unit: 'percent',
      observedAt: '2026-10-10T11:30:00Z',
      resetsAt: '2026-10-10T13:00:00Z',
      source: 'Codex native limits',
      sourceKind: 'official',
    },
  ],
};
const enrolled = [
  {
    account: {
      id: 'legacy-agy',
      label: 'enrolled-agy',
      provider: 'antigravity',
      identity: 'enrolled@example.test',
      status: 'ready',
    },
    quota: null,
  },
];

test('unified accounts show native configurations and enrolled scopes without inventing logged-in identity', () => {
  const text = inventoryAccounts({ native, enrolled, warnings: [] }).join('\n');
  assert.match(text, /▾ codex/);
  assert.match(text, /▾ antigravity/);
  assert.match(text, /native@example.test/);
  assert.match(text, /enrolled@example.test/);
  assert.match(text, /existing-agy · login not verified/);
  assert.match(text, /not proof of a logged-in account/);
});

test('unified usage preserves stale/source/reset evidence and separates unknown Antigravity balances', () => {
  const text = inventoryUsage(
    { native, enrolled, warnings: ['Fixture provider unavailable'] },
    80,
    now,
  )
    .map((line) => line.text)
    .join('\n');
  assert.match(text, /75.0% window remaining/);
  assert.match(text, /stale · official/);
  assert.match(text, /Refreshes in 1h 0m/);
  assert.match(text, /refreshed/);
  assert.match(text, /Usage unavailable · Statusline observer required/);
  assert.match(text, /PRINCIPAL-ENROLLED ACCOUNTS/);
  assert.match(text, /Gemini/);
  assert.match(text, /Claude/);
  assert.match(text, /limits are never added together/);
  assert.match(text, /Fixture provider unavailable/);
});

test('public entrypoint has no shell subcommands and redirects old commands to the TUI', async () => {
  for (const args of [['--help'], ['usage'], ['dashboard'], ['profiles', 'list']]) {
    const child = spawn(process.execPath, ['bin/principal.mjs', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (b) => (text += b));
    child.stderr.on('data', (b) => (text += b));
    const [code] = await once(child, 'exit');
    assert.equal(code, args[0] === '--help' ? 0 : 1);
    assert.match(text, /TUI|interactive terminal/);
    if (args[0] === '--help') assert(!text.includes('Commands:'));
  }
});

test('provider usage isolates tools, retains quota evidence, and labels missing integration', () => {
  const value = { native, enrolled, warnings: [] };
  const render = (tool) =>
    providerUsage(value, tool, 80, now)
      .map((l) => l.text)
      .join('\n');
  const codex = render('codex');
  assert.match(codex, /75.0% window remaining/);
  assert.doesNotMatch(codex, /enrolled-agy|existing-agy|Gemini/);
  const agy = render('antigravity');
  assert.match(agy, /enrolled-agy/);
  assert.match(render('copilot'), /no accounts or profiles discovered/);
  assert.deepEqual(
    usageTools.map((t) => t.id),
    ['codex', 'antigravity', 'copilot', 'claude'],
  );
});

test('cached enrollment metadata is read without migration or any database modification', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'principal-usage-cache-'));
  const file = path.join(root, 'principal.sqlite');
  try {
    const db = new Database(file);
    db.exec(
      'CREATE TABLE accounts(data TEXT); CREATE TABLE quotas(account_id TEXT, data TEXT); CREATE TABLE runs(data TEXT)',
    );
    db.prepare('INSERT INTO accounts VALUES(?)').run(JSON.stringify(enrolled[0].account));
    db.prepare('INSERT INTO runs VALUES(?)').run(JSON.stringify({ status: 'queued' }));
    db.close();
    const before = await readFile(file);
    assert.deepEqual(cachedEnrolledUsage(file), [{ account: enrolled[0].account, quota: null }]);
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readdir(root), ['principal.sqlite']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('existing usage reads fail without creating or starting a missing coordinator', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'principal-no-executor-'));
  try {
    const url = new URL('../dist/client.js', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {existingUsage} from ${JSON.stringify(url)}; try {await existingUsage(); process.exitCode=1;} catch(e) {if(e.code !== 'ENOENT') throw e;}`,
      ],
      {
        env: {
          ...process.env,
          HOME: root,
          XDG_STATE_HOME: path.join(root, 'state'),
          XDG_RUNTIME_DIR: path.join(root, 'runtime'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (b) => (stderr += b));
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, stderr);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('callback usage awaits native updates without claiming configured observers are missing', () => {
  const value = {
    native: {
      ...native,
      installations: [
        {
          tool: 'antigravity',
          capabilities: {
            observer: { supported: true },
            resources: {
              reason: 'Supported statusline observations require explicitly configured callback',
            },
          },
        },
      ],
    },
    enrolled: [],
    warnings: [],
  };
  const text = providerUsage(value, 'antigravity', 80, now)
    .map((l) => l.text)
    .join('\n');
  assert.match(text, /Waiting for profile-bound usage/);
  assert.doesNotMatch(text, /require explicitly configured callback/);
  assert.doesNotMatch(text, /100%/);
});

test('provider usage shows only warnings for the selected provider and shared service failures', () => {
  const value = {
    native,
    enrolled: [],
    warnings: [
      'codex: Observation backoff is active',
      'antigravity: fixture native warning',
      'Native management unavailable: fixture shared failure',
    ],
  };
  const text = providerUsage(value, 'antigravity', 100, now)
    .map((l) => l.text)
    .join('\n');
  assert.doesNotMatch(text, /Observation backoff/);
  assert.match(text, /fixture native warning/);
  assert.match(text, /fixture shared failure/);
  const codex = providerUsage(value, 'codex', 100, now)
    .map((l) => l.text)
    .join('\n');
  assert.match(codex, /Observation backoff/);
  assert.doesNotMatch(codex, /fixture native warning/);
});

test('profile inventory includes native logins, cached accounts and active unassigned sessions without inventing launch profiles', () => {
  const rows = profileInventory({
    native: {
      ...native,
      entries: [
        { id: 'external-entry', tool: 'antigravity', title: 'External agent', projectId: 'p' },
      ],
      projects: [{ id: 'p', directory: '/fixture/project' }],
      invocations: [
        { id: 'native-running', profileId: 'native-codex', endedAt: null, lifecycle: 'running' },
        {
          id: 'external-running',
          entryId: 'external-entry',
          profileId: null,
          endedAt: null,
          lifecycle: 'running',
          reportedAccount: null,
          observedAt: new Date(now).toISOString(),
        },
        {
          id: 'external-ended',
          entryId: 'external-entry',
          profileId: null,
          endedAt: '2026-10-10T00:00:00Z',
          lifecycle: 'exited',
        },
      ],
    },
    enrolled,
    warnings: [],
  });
  assert.equal(rows.length, 4);
  assert.equal(rows[0].nativeProfile.id, 'native-codex');
  assert.match(rows[0].status, /1 running process/);
  const cached = rows.find((r) => r.id === 'enrolled:legacy-agy');
  assert.equal(cached.nativeProfile, undefined);
  assert.match(cached.status, /cached.*not verified/);
  const external = rows.find((r) => r.id === 'external:external-running');
  assert.equal(external.nativeProfile, undefined);
  assert.match(external.status, /profile unassigned.*not verified/);
  assert(!rows.some((r) => r.id === 'external:external-ended'));
});

test('Antigravity renders only two weekly current-account windows and hides 5-hour observations', () => {
  const profile = { ...native.profiles[1], reportedAccount: 'current@example.test' };
  const observation = (bucket, value, observedAt, account = 'current@example.test') => ({
    profileId: profile.id,
    invocationId: observedAt,
    bucket,
    value,
    account,
    unit: 'percent',
    metric: 'quota-remaining',
    observedAt,
    resetsAt: '2026-10-10T15:00:00Z',
    source: 'Antigravity native statusline',
    sourceKind: 'official',
  });
  const value = {
    native: {
      ...native,
      profiles: [profile],
      resources: [
        observation('gemini-5h', 10, '2026-10-10T11:00:00Z'),
        observation('gemini-5h', 81, '2026-10-10T11:59:00Z'),
        observation('gemini-weekly', 52, '2026-10-10T11:58:00Z'),
        observation('3p-5h', 73, '2026-10-10T11:58:00Z'),
        observation('3p-weekly', 64, '2026-10-10T11:58:00Z'),
        observation('3p-weekly', 5, '2026-10-10T12:00:00Z', 'other@example.test'),
        observation('gemini-extra-model', 99, '2026-10-10T12:00:00Z'),
      ],
    },
    enrolled: [],
    warnings: [],
  };
  const rows = providerUsage(value, 'antigravity', 80, now);
  const text = rows.map((r) => r.text).join('\n');
  assert.equal(rows.filter((r) => r.text.includes('[')).length, 2);
  for (const title of ['Gemini · weekly', 'Claude · weekly'])
    assert.equal(text.split(title).length - 1, 1);
  for (const remaining of ['52.0%', '64.0%']) assert.ok(text.includes(remaining));
  assert.doesNotMatch(text, /5-hour|81.0%|73.0%|10.0%|5.0%|99.0%|gemini-extra-model/);
  value.native.resources = value.native.resources.filter((r) => r.bucket === 'gemini-weekly');
  const sparse = providerUsage(value, 'antigravity', 80, now);
  assert.equal(sparse.filter((r) => r.text.includes('[')).length, 2);
  assert.equal(sparse.filter((r) => r.text.includes('unavailable · not reported')).length, 1);
});
