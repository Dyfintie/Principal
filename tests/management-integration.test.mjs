import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const root = await mkdtemp(path.join(tmpdir(), 'principal-manager-integration-'));
const repo = fileURLToPath(new URL('../', import.meta.url));
const bin = path.join(root, 'bin');
const project = path.join(root, 'project');
const config = path.join(root, 'native-config');
for (const directory of [bin, project, config, path.join(root, 'runtime')]) await mkdir(directory);
const env = {
  ...process.env,
  PRINCIPAL_NATIVE_DIRECT: '1',
  HOME: root,
  CODEX_HOME: config,
  XDG_CONFIG_HOME: path.join(root, 'config'),
  PATH: `${bin}:/usr/bin:/bin`,
  XDG_STATE_HOME: path.join(root, 'state'),
  XDG_RUNTIME_DIR: path.join(root, 'runtime'),
};
for (const name of [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
])
  delete env[name];
const fake = path.join(bin, 'codex');
await writeFile(
  fake,
  `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.162.1'); process.exit(0); }
if (args[0] === 'app-server') {
  const lines = (await import('node:readline')).createInterface({ input: process.stdin });
  lines.on('line', async line => {
    const r = JSON.parse(line);
    if (r.id === undefined) return;
    let result = {};
    if (r.method === 'account/read') result = { account: { type: 'chatgpt', email: 'synthetic@example.test', planType: 'fixture-plan' } };
    if (r.method === 'account/rateLimits/read') result = { rateLimits: { limitId: 'codex', primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 2000000000 } } };
    if (r.method === 'thread/list') result = { data: [{ id: 'fixture-native-id', name: 'Fixture history', cwd: ${JSON.stringify(project)}, preview: 'PRIVATE-PREVIEW-MUST-NOT-PERSIST' }], nextCursor: r.params?.cursor ? null : 'fixture-next-page' };
    const delayFile = ${JSON.stringify(path.join(project, 'delay-usage'))};
    if (r.method === 'account/rateLimits/read' && (await import('node:fs')).existsSync(delayFile)) await new Promise(resolve => setTimeout(resolve, 2500));
    console.log(JSON.stringify({ id: r.id, result }));
  });
} else {
  const fs = await import('node:fs/promises');
  await fs.writeFile(${JSON.stringify(path.join(root, 'launch.json'))}, JSON.stringify({ args, cwd: process.cwd(), profile: process.env.CODEX_HOME, invocation: process.env.PRINCIPAL_INVOCATION_ID }));
  console.log('synthetic native invocation');
  if (args.includes('--wait')) setInterval(() => {}, 1000);
}
`,
  { mode: 0o700 },
);
let daemon;
await writeFile(
  path.join(bin, 'claude'),
  `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2.1.281 (Claude Code)'); process.exit(0); }
const fs = await import('node:fs/promises');
const { spawn } = await import('node:child_process');
setTimeout(() => {
  const helper = spawn(process.execPath, [${JSON.stringify(path.join(repo, 'dist', 'management', 'callback.js'))}, 'claude', 'hook'], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  helper.stdout.on('data', b => stdout += b);
  helper.stderr.on('data', b => stderr += b);
  helper.on('exit', async code => fs.writeFile(${JSON.stringify(path.join(root, 'hook-output.json'))}, JSON.stringify({ code, stdout, stderr })));
  helper.stdin.end(JSON.stringify({ session_id: 'fixture-claude-session', cwd: ${JSON.stringify(project)}, hook_event_name: 'PermissionRequest', prompt: 'PRIVATE-PROMPT', tool_input: { command: 'PRIVATE-COMMAND' } }));
}, 500);
setInterval(() => {}, 1000);
`,
  { mode: 0o700 },
);
async function start() {
  daemon = spawn(process.execPath, ['dist/management/daemon.js'], {
    cwd: repo,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  daemon.stdout.on('data', (b) => {
    log += b.toString();
  });
  daemon.stderr.on('data', (b) => {
    log += b.toString();
  });
  for (let i = 0; i < 150; i++) {
    if (log.includes('Principal management ready')) return;
    if (daemon.exitCode !== null) throw new Error(`Fixture daemon exited: ${log}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Fixture daemon did not become ready: ${log}`);
}
async function stop() {
  if (!daemon || daemon.exitCode !== null) return;
  const exited = once(daemon, 'exit');
  daemon.kill('SIGTERM');
  await exited;
}
async function cli(args, extraEnv = {}) {
  const child = spawn(process.execPath, ['scripts/management-test-driver.mjs', ...args], {
    cwd: repo,
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (b) => {
    stdout += b.toString();
  });
  child.stderr.on('data', (b) => {
    stderr += b.toString();
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  return { code, stdout, stderr };
}
async function json(args) {
  const result = await cli([...args, '--json']);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout).data;
}
test.before(start);
test.after(async () => {
  await stop();
  await rm(root, { recursive: true, force: true });
});

test('management CLI and isolated Unix daemon support native launch, real argument boundaries, history, quota and restart', async () => {
  const folder = await json(['folders', 'create', 'Work/Backend']);
  const profile = await json([
    'profiles',
    'add',
    'codex',
    '--label',
    'fixture',
    '--directory',
    config,
  ]);
  assert.equal(profile.reportedAccount, null);
  const literal = 'literal $(touch forbidden) `echo forbidden`';
  const launched = await cli([
    'launch',
    '--profile',
    'fixture',
    '--folder',
    'Work/Backend',
    '--cwd',
    project,
    '--title',
    'CLI fixture',
    '--',
    '--model',
    'fixture-model',
    '--extra',
    literal,
  ]);
  assert.equal(launched.code, 0, launched.stderr);
  const recorded = JSON.parse(await readFile(path.join(root, 'launch.json'), 'utf8'));
  assert.deepEqual(recorded.args, ['--no-daemon', '--model', 'fixture-model', '--extra', literal]);
  assert.equal(recorded.cwd, project);
  assert.equal(recorded.profile, config);
  assert.match(recorded.invocation, /^[a-f0-9-]{36}$/);
  let state = await json(['agents', 'list']);
  assert.equal(state.entries.length, 1);
  const entry = state.entries[0];
  assert.equal(entry.invocation.lifecycle, 'exited');
  assert.equal(entry.folderId, folder.id);
  assert.equal(entry.invocation.reportedAccount, null);
  assert.equal((await cli(['agents', 'stop', entry.invocation.id])).code, 1);
  const resources = await json(['resources', '--refresh']);
  assert.equal(resources.resources[0].value, 12.5);
  assert.equal(resources.resources[0].sourceKind, 'official');
  assert.equal(resources.resources[0].account, 'synthetic@example.test');
  assert.equal(resources.resources[0].freshness, 'cached');
  const history = await json(['agents', 'history', '--profile', 'fixture', '--cwd', project]);
  assert.equal(history.imported[0].title, 'Fixture history');
  assert(!JSON.stringify(history).includes('PRIVATE-PREVIEW'));
  const resumed = await cli(['agents', 'resume', history.imported[0].id]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'launch.json'), 'utf8')).args, [
    '--no-daemon',
    'resume',
    'fixture-native-id',
  ]);
  await json(['agents', 'archive', entry.id]);
  assert.equal((await json(['agents', 'list'])).entries.length, 1);
  assert.equal((await json(['agents', 'list', '--archived'])).entries[0].id, entry.id);
  assert.equal((await cli(['folders', 'delete', folder.id])).code, 1);
  const socket = path.join(root, 'runtime', 'principal-management', 'manager.sock');
  assert.equal((await stat(socket)).mode & 0o777, 0o600);
  await stop();
  await start();
  state = await json(['agents', 'list', '--archived']);
  assert.equal(state.entries[0].id, entry.id);
  assert.equal(state.entries[0].invocation.lifecycle, 'exited');
  const database = await readFile(
    path.join(root, 'state', 'principal', 'management', 'manager.sqlite'),
  );
  assert(!database.includes(Buffer.from('PRIVATE-PREVIEW')));
});

test('renaming during a delayed native quota refresh retains the name and removal waits for the probe', async () => {
  async function rpc(method, params = {}) {
    const source = `const { managementRpc } = await import('./dist/management/client.js'); console.log(JSON.stringify(await managementRpc(${JSON.stringify(method)}, ${JSON.stringify(params)})));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: repo,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    const [code] = await once(child, 'exit');
    if (code !== 0) throw new Error(stderr);
    return JSON.parse(stdout);
  }
  const original = (await rpc('profiles.list')).find((p) => p.label === 'fixture');
  const marker = path.join(project, 'delay-usage');
  await writeFile(marker, 'synthetic delay');
  const refresh = rpc('resources.refresh');
  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await rpc('profiles.rename', { profile: original.id, label: 'fixture-renamed' });
    await assert.rejects(rpc('profiles.remove', { profile: original.id }), /usage refresh/);
    await refresh;
    const current = (await rpc('profiles.list')).find((p) => p.id === original.id);
    assert.equal(current.label, 'fixture-renamed');
    assert.equal(current.auth, 'authenticated');
  } finally {
    await refresh.catch(() => {});
    await rm(marker, { force: true });
    await rpc('profiles.rename', { profile: original.id, label: 'fixture' });
  }
});

test('native launches refuse authentication overrides without exposing values', async () => {
  const result = await cli(
    ['launch', '--profile', 'fixture', '--cwd', project, '--', '--model', 'fixture'],
    { OPENAI_API_KEY: 'synthetic-private-secret' },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /OPENAI_API_KEY/);
  assert(!result.stderr.includes('synthetic-private-secret'));
});

test('stop requests reach the original launcher handle and terminate only its synthetic native child', async () => {
  const child = spawn(
    process.execPath,
    [
      'scripts/management-test-driver.mjs',
      'launch',
      '--profile',
      'fixture',
      '--cwd',
      project,
      '--title',
      'Owned stop fixture',
      '--',
      '--wait',
    ],
    { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (b) => {
    stderr += b.toString();
  });
  child.stdout.resume();
  const exited = once(child, 'exit');
  try {
    let invocation;
    for (let i = 0; i < 20; i++) {
      const state = await json(['agents', 'list']);
      invocation = state.entries.find((e) => e.title === 'Owned stop fixture')?.invocation;
      if (invocation?.lifecycle === 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(invocation?.lifecycle, 'running', stderr);
    await json(['agents', 'stop', invocation.id]);
    const timeout = setTimeout(() => child.kill('SIGTERM'), 8000);
    const [code] = await exited;
    clearTimeout(timeout);
    assert.equal(code, 143, stderr);
    const state = await json(['agents', 'list']);
    assert.equal(
      state.entries.find((e) => e.title === 'Owned stop fixture').invocation.lifecycle,
      'exited',
    );
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
});

test(
  'persistent tmux native sessions attach and detach without changing the agent identity or profile',
  { skip: !existsSync('/usr/bin/tmux') && !existsSync('/usr/sbin/tmux'), timeout: 30_000 },
  async () => {
    const code =
      "import {launchAgent} from './dist/management/launcher.js';process.exitCode=await launchAgent({profile:'fixture',directory:process.argv[1],title:'Persistent fixture',multiplex:true,args:['--wait']});";
    const launch = spawn(process.execPath, ['--input-type=module', '-e', code, project], {
      cwd: repo,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let error = '';
    launch.stdout.resume();
    launch.stderr.on('data', (b) => (error += b));
    let invocation;
    try {
      assert.equal((await once(launch, 'exit'))[0], 0, error);
      let row;
      for (let n = 0; n < 30; n++) {
        row = (await json(['agents', 'list'])).entries.find(
          (e) => e.title === 'Persistent fixture',
        );
        if (row?.invocation?.lifecycle === 'running') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(row?.invocation?.lifecycle, 'running');
      invocation = row.invocation;
      assert.equal(invocation.terminal.kind, 'tmux');
      const readPlan =
        "import {managementRpc} from './dist/management/client.js';console.log(JSON.stringify(await managementRpc('entries.reopen',{entry:process.argv[1]})));";
      const planProcess = spawn(process.execPath, ['--input-type=module', '-e', readPlan, row.id], {
        cwd: repo,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let plan = '';
      planProcess.stdout.on('data', (b) => (plan += b));
      planProcess.stderr.resume();
      assert.equal((await once(planProcess, 'exit'))[0], 0);
      assert.equal(JSON.parse(plan).mode, 'attach');
      assert.equal(JSON.parse(plan).stopInvocationId, null);
      for (let repeat = 0; repeat < 2; repeat++) {
        const client = spawn('python3', ['scripts/tmux-smoke.py', process.execPath, row.id], {
          cwd: repo,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let clientError = '';
        client.stdout.resume();
        client.stderr.on('data', (b) => (clientError += b));
        assert.equal((await once(client, 'exit'))[0], 0, clientError);
        const current = (await json(['agents', 'list'])).entries.find(
          (e) => e.id === row.id,
        ).invocation;
        assert.equal(current.id, invocation.id);
        assert.deepEqual(current.identity, invocation.identity);
        assert.equal(current.lifecycle, 'running');
        assert.equal(current.stopRequestedAt, undefined);
      }
      const native = JSON.parse(await readFile(path.join(root, 'launch.json'), 'utf8'));
      assert.equal(native.profile, config);
      assert.equal(native.cwd, project);
    } finally {
      if (invocation) {
        await json(['agents', 'stop', invocation.id]);
        for (let n = 0; n < 30; n++) {
          const current = (await json(['agents', 'list'])).entries.find(
            (e) => e.title === 'Persistent fixture',
          ).invocation;
          if (current.lifecycle === 'exited') break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      if (launch.exitCode === null) launch.kill('SIGTERM');
    }
  },
);

test('reopen stops only the confirmed synthetic invocation, waits for exit and launches native resume in the same entry', async () => {
  const child = spawn(
    process.execPath,
    [
      'scripts/management-test-driver.mjs',
      'launch',
      '--profile',
      'fixture',
      '--cwd',
      project,
      '--title',
      'Reopen fixture',
      '--',
      '--wait',
    ],
    { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.resume();
  child.stderr.resume();
  const exited = once(child, 'exit');
  let reopening;
  try {
    let row;
    for (let n = 0; n < 30; n++) {
      row = (await json(['agents', 'list'])).entries.find((e) => e.title === 'Reopen fixture');
      if (row?.invocation?.lifecycle === 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(row?.invocation?.lifecycle, 'running');
    const first = row.invocation.id;
    const code =
      "import {reopenEntry} from './dist/management/launcher.js';process.exitCode=await reopenEntry(process.argv[1],process.argv[2]);";
    reopening = spawn(process.execPath, ['--input-type=module', '-e', code, row.id, first], {
      cwd: repo,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let error = '';
    reopening.stdout.resume();
    reopening.stderr.on('data', (b) => (error += b));
    const timeout = setTimeout(() => reopening.kill('SIGTERM'), 15000);
    const [result] = await once(reopening, 'exit');
    clearTimeout(timeout);
    assert.equal(result, 0, error);
    assert.equal((await exited)[0], 143);
    const native = JSON.parse(await readFile(path.join(root, 'launch.json'), 'utf8'));
    assert.ok(native.args.includes('resume'));
    assert.equal(native.cwd, project);
    assert.equal(native.profile, config);
    const saved = (await json(['agents', 'list'])).entries.find((e) => e.id === row.id);
    assert.notEqual(saved.invocation.id, first);
    assert.equal(saved.invocation.lifecycle, 'exited');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (reopening && reopening.exitCode === null) reopening.kill('SIGTERM');
  }
});

test('real PTY dashboard uses slash-only views, stays navigable during refresh, and returns from native resume', async () => {
  const legacyDatabase = path.join(root, 'state', 'principal', 'principal.sqlite');
  await writeFile(legacyDatabase, 'synthetic inventory presence');
  const legacyCalls = [];
  const legacy = createServer(async (request, response) => {
    let body = '';
    for await (const b of request) body += b;
    const message = JSON.parse(body);
    legacyCalls.push(message);
    const result =
      message.method === 'usage'
        ? [
            {
              account: {
                id: 'enrolled-fixture',
                label: 'enrolled-fixture',
                provider: 'antigravity',
                status: 'ready',
                identity: 'enrolled@example.test',
              },
              quota: null,
            },
          ]
        : [];
    response.end(JSON.stringify({ result }));
  });
  await new Promise((resolve) =>
    legacy.listen(path.join(root, 'state', 'principal', 'daemon.sock'), resolve),
  );
  try {
    const child = spawn(
      'python',
      [
        'scripts/management-smoke.py',
        process.execPath,
        path.join(repo, 'bin', 'principal.mjs'),
        project,
      ],
      { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (b) => {
      stdout += b.toString();
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
    const [code] = await once(child, 'exit');
    clearTimeout(timer);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /PASS: native management PTY/);
    const nativeLaunch = JSON.parse(await readFile(path.join(root, 'launch.json'), 'utf8'));
    assert.deepEqual(nativeLaunch.args, ['--no-daemon']);
    assert.notEqual(nativeLaunch.profile, config);
    assert.equal(nativeLaunch.cwd, project);
    const antigravity = (await json(['profiles', 'list'])).find((p) => p.tool === 'antigravity');
    assert.equal(antigravity.auth, 'authenticated');
    assert.equal(antigravity.reportedAccount, 'antigravity-fixture@example.test');
    assert(legacyCalls.some((c) => c.method === 'usage'));
    assert(
      legacyCalls.filter((c) => c.method === 'usage').every((c) => c.args.refresh === false),
      'Management usage must not refresh historical execution runtimes',
    );
    assert(
      legacyCalls.every((c) => ['usage', 'accounts.list'].includes(c.method)),
      'Management navigation must not create conversations or invoke inference',
    );
  } finally {
    await new Promise((resolve) => legacy.close(resolve));
    await rm(legacyDatabase);
  }
});

test('opted-in native hook records activity and conversation without emitting context or exposing tool input', async () => {
  await json(['profiles', 'add', 'claude', '--label', 'claude-fixture', '--directory', config]);
  const recipe = await json(['profiles', 'observer', 'claude-fixture']);
  assert.equal(recipe.merge.hooks.PermissionRequest[0].hooks[0].type, 'command');
  const child = spawn(
    process.execPath,
    [
      'scripts/management-test-driver.mjs',
      'launch',
      '--profile',
      'claude-fixture',
      '--cwd',
      project,
      '--title',
      'Hook fixture',
    ],
    { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.resume();
  child.stderr.resume();
  const exited = once(child, 'exit');
  try {
    let entry;
    for (let i = 0; i < 20; i++) {
      const state = await json(['agents', 'list']);
      assert(!JSON.stringify(state).includes('PRIVATE-'));
      entry = state.entries.find((e) => e.title === 'Hook fixture');
      if (entry?.invocation?.activity === 'awaiting-user') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(entry?.invocation?.activity, 'awaiting-user');
    assert.equal(entry.invocation.activitySource, 'Claude PermissionRequest hook');
    assert.equal(entry.invocation.reportedDirectory, project);
    assert(entry.conversationId);
    for (let i = 0; i < 20; i++) {
      try {
        await stat(path.join(root, 'hook-output.json'));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'hook-output.json'), 'utf8')), {
      code: 0,
      stdout: '',
      stderr: '',
    });
    await json(['agents', 'stop', entry.invocation.id]);
    const timer = setTimeout(() => child.kill('SIGTERM'), 8000);
    assert.equal((await exited)[0], 143);
    clearTimeout(timer);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
});

test('unknown installed versions keep launch available and disable deep observations', async () => {
  await writeFile(
    fake,
    `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('codex-cli 999.0.0'); else console.log('fixture unknown-version launch');\n`,
    { mode: 0o700 },
  );
  const doctor = await json(['doctor']);
  const codex = doctor.installations.find((i) => i.tool === 'codex');
  assert.equal(codex.capabilities.launch.supported, true);
  assert.equal(codex.capabilities.resources.supported, false);
  assert.equal(codex.capabilities.resume.supported, false);
  assert.equal(doctor.inferencePerformed, false);
  const launched = await cli(['launch', '--profile', 'fixture', '--cwd', project]);
  assert.equal(launched.code, 0, launched.stderr);
});
