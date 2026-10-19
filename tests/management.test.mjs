import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = await mkdtemp(path.join(tmpdir(), 'principal-management-unit-'));
process.env.XDG_STATE_HOME = path.join(root, 'state');
process.env.XDG_RUNTIME_DIR = path.join(root, 'runtime');
await mkdir(process.env.XDG_RUNTIME_DIR);
const { initManagementPaths, environment, managementPaths } =
  await import('../dist/management/paths.js');
await initManagementPaths();
const { ManagementStore } = await import('../dist/management/store.js');
const { ManagementService } = await import('../dist/management/service.js');
const { processIdentity, identityMatches, discoverProcesses, forceStopOwned } =
  await import('../dist/management/process.js');
const { flattenTree, invocationLabel } = await import('../dist/management/tree.js');
const { normalizeStatusline, normalizeCodexLimits, normalizeClaudeHook } =
  await import('../dist/management/observations.js');
const { authenticationConflicts, buildNativeLaunch, profileEnvironment } =
  await import('../dist/management/providers.js');
const { freshness, normalizeTool } = await import('../dist/management/model.js');
const env = await environment();
const cap = (supported) => ({
  supported,
  reason: 'fixture capability',
  confidence: supported ? 'verified-interface' : 'unverified',
});
const installs = ['codex', 'claude', 'copilot', 'antigravity'].map((tool) => ({
  tool,
  executable: path.join(root, tool),
  version: 'fixture',
  verifiedVersion: true,
  checkedAt: new Date().toISOString(),
  source: 'fixture',
  capabilities: {
    launch: cap(true),
    configurationIsolation: cap(['codex', 'claude'].includes(tool)),
    independentAuthentication: cap(false),
    resume: cap(true),
    history: cap(false),
    resources: cap(false),
    observer: cap(['claude', 'antigravity'].includes(tool)),
  },
}));
function fixture(file = ':memory:') {
  const store = new ManagementStore(file);
  const service = new ManagementService(store, env);
  service.installations = installs;
  return { store, service };
}
async function profile(service, tool = 'codex', label = 'personal') {
  const directory = path.join(root, `${tool}-${label}`);
  await mkdir(directory, { recursive: true });
  return service.addProfile({ tool, label, directory });
}
test.after(async () => rm(root, { recursive: true, force: true }));

test('daemon resource collection runs every minute and shares overlapping refresh jobs', async () => {
  const { store, service } = fixture();
  const originalNow = Date.now;
  let now = originalNow();
  try {
    await profile(service, 'codex', 'minute-refresh');
    let collections = 0;
    let complete;
    service.collectResources = async () => {
      collections++;
      await new Promise((resolve) => {
        complete = resolve;
      });
      return { results: [], resources: [] };
    };
    const first = service.refreshResources();
    assert.equal(service.refreshResources(), first);
    assert.equal(collections, 1);
    complete();
    await first;
    let cycles = 0;
    service.refreshResources = async () => {
      cycles++;
      return { results: [], resources: [] };
    };
    Date.now = () => now;
    await service.tick();
    assert.equal(cycles, 1);
    now += 59_000;
    await service.tick();
    assert.equal(cycles, 1);
    now += 1000;
    await service.tick();
    assert.equal(cycles, 2);
  } finally {
    Date.now = originalNow;
    store.close();
  }
});

test('folders persist with stable IDs, rename preserves descendants, and cyclic moves are rejected', async () => {
  const file = path.join(managementPaths.state, 'folders.sqlite');
  const { store } = fixture(file);
  const child = store.createFolder(['Work', 'Backend']);
  const parent = store.folder('Work');
  assert.throws(() => store.updateFolder(parent.id, { parentId: child.id }), /cycle/);
  store.updateFolder(parent.id, { name: 'Team' });
  assert.equal(store.folder('Team/Backend').id, child.id);
  assert.throws(() => store.deleteFolder(parent.id), /contents/);
  assert.throws(() => store.deleteFolder('unassigned'), /protected/);
  store.saveUI({ expanded: [`f:${parent.id}`], selected: `f:${child.id}` });
  const seq = store.seq;
  store.close();
  const reopened = new ManagementStore(file);
  assert.equal(reopened.folder('Team/Backend').id, child.id);
  assert.equal(reopened.ui().selected, `f:${child.id}`);
  assert.equal(reopened.seq, seq);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  reopened.close();
});

test('registration distinguishes profiles from accounts and refuses fake account isolation', async () => {
  const { store, service } = fixture();
  const a = await profile(service);
  const b = await service.addProfile({ tool: 'codex', label: 'work', isolated: true });
  assert.notEqual(a.directory, b.directory);
  assert.equal(a.auth, 'unknown');
  assert.equal(a.reportedAccount, null);
  await assert.rejects(
    service.addProfile({ tool: 'copilot', label: 'second', isolated: true }),
    /fixture capability/,
  );
  await assert.rejects(
    service.addProfile({ tool: 'codex', label: 'alias', directory: a.directory }),
    /already registered/,
  );
  await assert.rejects(
    service.addProfile({ tool: 'claude', label: 'personal', isolated: true }),
    /unique/,
  );
  await assert.rejects(service.rpc('folders.create', { path: 'Work//Empty' }));
  store.close();
});

test('profile selection overrides only the supported directory selector and reports credential overrides without values', () => {
  const p = { tool: 'codex', directory: '/fixture/codex' };
  const inherited = {
    CODEX_HOME: '/other',
    OPENAI_API_KEY: 'fixture-private-value',
    TERM: 'xterm',
  };
  assert.deepEqual(authenticationConflicts(p, inherited), ['OPENAI_API_KEY']);
  assert.equal(profileEnvironment(p, inherited).CODEX_HOME, '/fixture/codex');
  assert.equal(profileEnvironment(p, inherited).TERM, 'xterm');
  const launch = buildNativeLaunch(p, installs[0], ['--model', 'chosen']);
  assert.deepEqual(launch.args, ['--no-daemon', '--model', 'chosen']);
  assert(!launch.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.deepEqual(buildNativeLaunch(p, installs[0], [], 'native-id').args, [
    '--no-daemon',
    'resume',
    'native-id',
  ]);
  assert.throws(
    () =>
      buildNativeLaunch(
        p,
        { ...installs[0], capabilities: { ...installs[0].capabilities, resume: cap(false) } },
        [],
        'native-id',
      ),
    /fixture capability/,
  );
});

test('Codex profile launches bypass shared authentication and device login keeps the same profile', async () => {
  const { buildLoginLaunch } = await import('../dist/management/providers.js');
  const p = { tool: 'codex', directory: '/fixture/account-two' };
  const launch = buildNativeLaunch(p, installs[0], ['--no-daemon']);
  assert.deepEqual(launch.args, ['--no-daemon']);
  const login = buildLoginLaunch(p, installs[0], true);
  assert.deepEqual(login.args, ['login', '--device-auth']);
  assert.equal(login.env.CODEX_HOME, launch.env.CODEX_HOME);
  assert.deepEqual(buildLoginLaunch(p, installs[0]).args, ['login']);
  assert.throws(
    () => buildLoginLaunch({ ...p, tool: 'claude' }, installs[1], true),
    /supported Codex/,
  );
  assert.throws(
    () => buildLoginLaunch(p, { ...installs[0], verifiedVersion: false }, true),
    /supported Codex/,
  );
  assert.deepEqual(buildNativeLaunch(p, { ...installs[0], verifiedVersion: false }, []).args, []);
});

test('owned invocation lifecycle survives database restart without replay; stop rejects reused and external PIDs', async () => {
  const file = path.join(managementPaths.state, 'processes.sqlite');
  let { store, service } = fixture(file);
  const p = await profile(service, 'claude', 'process-test');
  const prepared = await service.prepare({
    profile: p.id,
    directory: root,
    wrapper: await processIdentity(process.pid),
  });
  assert.equal(prepared.entry.profileId, p.id);
  assert.equal(prepared.invocation.reportedAccount, null);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const exited = once(child, 'exit');
  try {
    const identity = await processIdentity(child.pid);
    await service.registered({ id: prepared.invocation.id, identity });
    await assert.rejects(
      service.rpc('launch.exit', { id: prepared.invocation.id, exitCode: 0 }),
      /still alive/,
    );
    assert.equal(await identityMatches({ ...identity, startTime: 'incorrect' }), false);
    store.close();
    ({ store, service } = fixture(file));
    assert.equal(service.snapshot().invocations[0].lifecycle, 'running');
    assert.equal(await identityMatches(identity), true);
    store.put('invocation', {
      ...store.require('invocation', prepared.invocation.id),
      identity: { ...identity, startTime: 'incorrect' },
    });
    await assert.rejects(service.stop(prepared.invocation.id), /identity changed/);
    store.put('invocation', {
      ...prepared.invocation,
      identity,
      owned: false,
      lifecycle: 'running',
    });
    await assert.rejects(service.stop(prepared.invocation.id), /Principal-launched/);
    store.put('invocation', {
      ...prepared.invocation,
      identity,
      owned: true,
      lifecycle: 'running',
    });
    await service.stop(prepared.invocation.id);
    assert.equal(
      await identityMatches(identity),
      true,
      'Daemon queues control instead of signaling a bare PID',
    );
    const control = await service.rpc('invocations.control', {
      id: prepared.invocation.id,
      wrapper: await processIdentity(process.pid),
    });
    assert(control.stopRequestedAt);
    child.kill('SIGTERM'); // Original ChildProcess owner performs the queued action.
    await exited;
    await service.tick();
    assert.equal(service.snapshot().invocations[0].lifecycle, 'exited');
    assert.equal(service.snapshot().entries.length, 1);
  } finally {
    child.kill('SIGTERM');
    store.close();
  }
});

test('statusline normalization retains supported quota fields and drops prompts, tokens, and context percentages', () => {
  const claude = normalizeStatusline(
    'claude',
    {
      session_id: 'native-one',
      cwd: root,
      prompt: 'private fixture',
      access_token: 'private fixture',
      context_window: { used_percentage: 99 },
      rate_limits: {
        five_hour: { used_percentage: 12, resets_at: 2000000000 },
        seven_day: { used_percentage: 0 },
      },
    },
    [123],
  );
  assert.equal(claude.resources.length, 2);
  assert.equal(claude.resources[0].value, 12);
  assert.equal(claude.resources[1].value, 0);
  assert.equal(claude.activity, undefined);
  assert(!JSON.stringify(claude).includes('private fixture'));
  const agy = normalizeStatusline(
    'antigravity',
    {
      conversation_id: 'native-two',
      agent_state: 'working',
      tool_confirmation_pending: true,
      email: 'fixture@example.test',
      quota: {
        weekly: { remaining_fraction: 0.25, reset_time: '2026-10-12T00:00:00Z' },
        malformed: { remaining_fraction: 2 },
      },
    },
    [321],
  );
  assert.equal(agy.activity, 'awaiting-user');
  assert.equal(agy.resources.length, 1);
  assert.equal(agy.resources[0].value, 25);
  assert.equal(agy.account, 'fixture@example.test');
  assert.equal(freshness('2000-01-01T00:00:00Z'), 'stale');
  const codex = normalizeCodexLimits(
    { id: 'profile', reportedAccount: null },
    {
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 0, resetsAt: 2000000000, windowDurationMins: 300 },
          secondary: { usedPercent: 120 },
        },
      },
    },
  );
  assert.equal(codex.length, 1);
  assert.equal(codex[0].metric, 'rate-limit-used');
  assert.equal(codex[0].value, 0);
});

test('Antigravity startup statusline accepts an empty conversation ID without discarding account or quota', () => {
  const observation = normalizeStatusline(
    'antigravity',
    {
      conversation_id: '',
      session_id: '',
      email: 'startup@example.test',
      agent_state: 'idle',
      quota: { weekly: { remaining_fraction: 0.75 } },
    },
    [321],
  );
  assert.equal(observation.conversationId, undefined);
  assert.equal(observation.account, 'startup@example.test');
  assert.equal(observation.resources[0].value, 75);
  assert.equal(
    normalizeStatusline('antigravity', { email: '', conversation_id: '' }, [321]).account,
    undefined,
  );
});

test('native observations bind conversations with temporal evidence; stale streams do not imply idle or terminated', async () => {
  const { store, service } = fixture();
  const p = await profile(service, 'antigravity', 'observer').catch(() => null);
  assert.equal(p, null); // Arbitrary AGY directories are not a credential isolation mechanism.
  const cp = await profile(service, 'claude', 'observer');
  const prepared = await service.prepare({
    profile: cp.id,
    directory: root,
    wrapper: await processIdentity(process.pid),
  });
  const identity = await processIdentity(process.pid);
  store.put('invocation', { ...prepared.invocation, identity, lifecycle: 'running' });
  const callback = normalizeStatusline(
    'claude',
    { session_id: 'one', rate_limits: { five_hour: { used_percentage: 50 } } },
    [process.pid],
    prepared.invocation.id,
  );
  await service.observe(callback);
  await service.observe({ ...callback, conversationId: 'two' });
  const before = service.snapshot();
  assert.equal(before.conversations.length, 2);
  assert.equal(before.bindings.filter((b) => !b.endedAt).length, 1);
  assert.equal(before.bindings[0].evidence, 'native-callback');
  const invocation = before.invocations[0];
  store.put('invocation', { ...invocation, observedAt: '2000-01-01T00:00:00Z' });
  await service.tick();
  const after = service.snapshot().invocations[0];
  assert.equal(after.lifecycle, 'running');
  assert.equal(after.activity, 'unknown');
  assert.equal(after.connection, 'stale');
  await assert.rejects(service.observe({ ...callback, ancestorPids: [] }), /associated/);
  assert.equal(store.resources().length, 1);
  store.close();
});

test('Claude lifecycle signals exclude prompts and tool data and preserve native permission decisions', () => {
  const input = {
    session_id: 'hook-session',
    cwd: root,
    prompt: 'PRIVATE-PROMPT',
    tool_input: { command: 'PRIVATE-COMMAND' },
    hook_event_name: 'PermissionRequest',
  };
  const request = normalizeClaudeHook(input, [123]);
  assert.equal(request.activity, 'awaiting-user');
  assert.equal(request.activitySource, 'Claude PermissionRequest hook');
  assert(!JSON.stringify(request).includes('PRIVATE-'));
  assert.equal('decision' in request, false);
  assert.equal(
    normalizeClaudeHook({ ...input, hook_event_name: 'UserPromptSubmit' }, [123]).activity,
    'working',
  );
  assert.equal(normalizeClaudeHook({ ...input, hook_event_name: 'Stop' }, [123]).activity, 'idle');
  assert.throws(() => normalizeClaudeHook({ ...input, hook_event_name: 'Unexpected' }, [123]));
});

test('tree search exposes ancestors without changing saved expansion and archive does not modify processes or files', async () => {
  const { store, service } = fixture();
  const p = await profile(service, 'codex', 'tree');
  const folder = store.createFolder(['Work', 'Backend']);
  const prepared = await service.prepare({
    profile: p.id,
    directory: root,
    folder: folder.id,
    title: 'Fix authentication',
    wrapper: await processIdentity(process.pid),
  });
  const expanded = new Set();
  const snapshot = service.snapshot();
  assert(!flattenTree(snapshot, expanded).some((r) => r.entryId));
  const searched = flattenTree(snapshot, expanded, 'authentication');
  assert(searched.some((r) => r.entryId === prepared.entry.id));
  assert.equal(expanded.size, 0);
  const sequence = searched.map((r) => r.id);
  store.put('invocation', { ...prepared.invocation, activity: 'working' });
  assert.deepEqual(
    flattenTree(service.snapshot(), expanded, 'authentication').map((r) => r.id),
    sequence,
  );
  await service.rpc('entries.update', { id: prepared.entry.id, archived: true });
  assert(!flattenTree(service.snapshot(), expanded, 'authentication').some((r) => r.entryId));
  assert(flattenTree(service.snapshot(), expanded, 'authentication', true).some((r) => r.entryId));
  assert.equal(store.require('invocation', prepared.invocation.id).lifecycle, 'starting');
  assert.throws(() => store.deleteFolder(folder.id), /contents/);
  assert.equal(
    invocationLabel({ lifecycle: 'running', connection: 'connected', activity: 'unknown' }),
    'Running · activity unknown',
  );
  store.close();
});

test('external discovery recognizes only the approved executable position and records no command-line text', async () => {
  const script = path.join(root, 'native-fixture.mjs');
  await writeFile(script, 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [script, 'private-prompt-fixture'], {
    cwd: root,
    stdio: 'ignore',
  });
  await once(child, 'spawn');
  const exited = once(child, 'exit');
  try {
    const discovered = await discoverProcesses([{ ...installs[0], executable: script }]);
    const item = discovered.find((p) => p.identity.pid === child.pid);
    assert(item);
    assert(!JSON.stringify(item).includes('private-prompt-fixture'));
    const { store, service } = fixture();
    const invocation = service.registerExternal(item);
    assert.equal(invocation.owned, false);
    assert.equal(invocation.profileId, null);
    assert.equal(service.registerExternal(item).id, invocation.id);
    await assert.rejects(service.stop(invocation.id), /Principal-launched/);
    store.close();
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
});

test('TUI native options preserve quoted argument boundaries without shell expansion', async () => {
  const { nativeArguments } = await import('../dist/management/arguments.js');
  assert.deepEqual(
    nativeArguments(`--model "two words" '' '$HOME' '$(touch /tmp/no)' '` + '`uname`' + `'`),
    ['--model', 'two words', '', '$HOME', '$(touch /tmp/no)', '`uname`'],
  );
  assert.deepEqual(nativeArguments(''), []);
  assert.throws(() => nativeArguments('"unfinished'), /Close quotes/);
  assert.throws(() => nativeArguments('unfinished' + String.fromCharCode(92)), /complete escapes/);
});

test('existing profile discovery registers references idempotently without reading or modifying credentials', async () => {
  const saved = Object.fromEntries(
    ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'COPILOT_HOME'].map((name) => [
      name,
      process.env[name],
    ]),
  );
  const home = path.join(root, 'discovery-home');
  const directory = path.join(home, 'codex');
  await mkdir(directory, { recursive: true });
  const credential = path.join(directory, 'auth.json');
  await writeFile(credential, 'SYNTHETIC-CREDENTIAL-DO-NOT-TOUCH', { mode: 0o600 });
  const before = await stat(credential);
  const { store, service } = fixture();
  try {
    process.env.HOME = home;
    process.env.CODEX_HOME = directory;
    process.env.CLAUDE_CONFIG_DIR = path.join(home, 'absent-claude');
    process.env.COPILOT_HOME = path.join(home, 'absent-copilot');
    const { discoverNativeProfiles } = await import('../dist/management/discovery.js');
    const request = (method, args) => service.rpc(method, args);
    const first = await discoverNativeProfiles(request);
    const second = await discoverNativeProfiles(request);
    assert.equal(first.profiles.length, 1);
    assert.equal(second.profiles[0].id, first.profiles[0].id);
    assert.equal(first.profiles[0].auth, 'unknown');
    assert.equal(first.profiles[0].reportedAccount, null);
    assert.equal(first.profiles[0].directory, directory);
    await service.rpc('profiles.remove', { profile: first.profiles[0].id });
    assert.equal((await discoverNativeProfiles(request)).profiles.length, 0);
    assert.equal(service.snapshot().profiles.length, 0);
    // Stale discovery snapshots cannot undo explicit removal either.
    assert.equal(
      await service.addProfile({
        tool: 'codex',
        label: 'discovery-retry',
        directory,
        discovery: true,
      }),
      null,
    );
    const restored = await service.addProfile({ tool: 'codex', label: 'restored', directory });
    assert.equal(restored.id, first.profiles[0].id);
    assert.equal((await discoverNativeProfiles(request)).profiles[0].label, 'restored');
    assert.equal((await stat(credential)).mtimeMs, before.mtimeMs);
    assert.equal((await stat(credential)).atimeMs, before.atimeMs);
    await assert.rejects(stat(process.env.CLAUDE_CONFIG_DIR), { code: 'ENOENT' });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    store.close();
  }
});

test('Copilot npm platform resolution and wrapped process discovery use exact installed paths', async () => {
  const { copilotExecutables } = await import('../dist/management/providers.js');
  const directory = path.join(root, 'npm-fixture', '@github', 'copilot');
  const platform = path.join(
    directory,
    'node_modules',
    '@github',
    `copilot-${process.platform}-${process.arch}`,
  );
  await mkdir(platform, { recursive: true });
  const loader = path.join(directory, 'npm-loader.js');
  const native = path.join(platform, 'copilot.mjs');
  await writeFile(path.join(platform, 'package.json'), JSON.stringify({ main: 'copilot.mjs' }));
  await writeFile(native, 'setInterval(() => {}, 1000);', { mode: 0o700 });
  await writeFile(
    loader,
    `const {spawn} = require('node:child_process'); const child = spawn(process.execPath, [${JSON.stringify(native)}], {stdio:'ignore'}); child.once('spawn',()=>console.log(child.pid)); child.once('exit',()=>process.exit()); process.on('SIGTERM',()=>child.kill('SIGTERM'));`,
  );
  const approved = await copilotExecutables(loader);
  assert(approved.includes(native));
  assert.deepEqual(await copilotExecutables('/unrelated/copilot'), ['/unrelated/copilot']);
  const child = spawn(process.execPath, [loader], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = once(child, 'exit');
  const [chunk] = await once(child.stdout, 'data');
  const pid = Number(chunk.toString().trim());
  const installation = { ...installs[2], executable: loader, processExecutables: approved };
  assert.equal(
    buildNativeLaunch({ tool: 'copilot', directory: root }, installation, []).executable,
    native,
  );
  const { buildLoginLaunch } = await import('../dist/management/providers.js');
  assert.equal(
    buildLoginLaunch({ tool: 'copilot', directory: root }, installation).executable,
    native,
  );
  try {
    const found = await discoverProcesses([installation]);
    assert(found.some((i) => i.identity.pid === pid && i.tool === 'copilot'));
    assert(
      !found.some((i) => i.identity.pid === child.pid),
      'Do not double count the npm launcher',
    );
    const probe = spawn(process.execPath, [native, '--headless', '--stdio'], { stdio: 'ignore' });
    const probeExit = once(probe, 'exit');
    await once(probe, 'spawn');
    try {
      assert(!(await discoverProcesses([installation])).some((i) => i.identity.pid === probe.pid));
    } finally {
      probe.kill('SIGTERM');
      await probeExit;
    }
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
});

test('Copilot authentication reads only supported status, handles framed chunks, and persists no secret fields', async () => {
  const native = path.join(root, 'copilot-auth-fixture');
  const capture = path.join(root, 'copilot-auth-requests.json');
  await writeFile(
    native,
    `#!${process.execPath}
const fs = require('node:fs'); let buffer = Buffer.alloc(0);
process.stdin.on('data', chunk => {
 buffer = Buffer.concat([buffer, chunk]); const end = buffer.indexOf('\\r\\n\\r\\n'); if(end<0) return;
 const len = Number(buffer.subarray(0,end).toString().match(/Content-Length: (\\d+)/)[1]); if(buffer.length < end+4+len) return;
 const request = JSON.parse(buffer.subarray(end+4,end+4+len));
 fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(request));
 const body = JSON.stringify({jsonrpc:'2.0',id:request.id,result:{isAuthenticated:true,login:'fixture-github-user',token:'PRIVATE-TOKEN',statusMessage:'PRIVATE-MESSAGE'}});
 const frame = 'Content-Length: '+Buffer.byteLength(body)+'\\r\\n\\r\\n'+body;
 process.stdout.write(frame.slice(0,12)); setTimeout(()=>process.stdout.write(frame.slice(12)),20);
});`,
    { mode: 0o700 },
  );
  const { store, service } = fixture();
  service.installations = installs.map((i) =>
    i.tool === 'copilot'
      ? {
          ...i,
          executable: native,
          capabilities: { ...i.capabilities, configurationIsolation: cap(true) },
        }
      : i,
  );
  const copilotProfile = await profile(service, 'copilot', 'auth-copilot');
  try {
    const result = await service.inspectProfile(copilotProfile.id);
    assert.equal(result.profile.auth, 'authenticated');
    assert.equal(result.profile.reportedAccount, 'fixture-github-user');
    const { readFile } = await import('node:fs/promises');
    const request = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(request.method, 'auth.getStatus');
    assert.deepEqual(request.params, {});
    assert(!JSON.stringify(service.snapshot()).includes('PRIVATE-'));
  } finally {
    store.close();
  }
});

test('normal tree hides ended generic external sightings while retaining live agents and owned/history records', async () => {
  const { store, service } = fixture();
  const identity = await processIdentity(process.pid);
  const external = service.registerExternal({ identity, tool: 'antigravity', directory: root });
  const expanded = new Set([
    'f:unassigned',
    `p:unassigned:${store.require('entry', external.entryId).projectId}`,
  ]);
  assert(flattenTree(service.snapshot(), expanded).some((r) => r.entryId === external.entryId));
  store.finish(external, 0);
  assert(!flattenTree(service.snapshot(), expanded).some((r) => r.entryId === external.entryId));
  assert(store.require('entry', external.entryId), 'Keep the original observation record');
  const renamed = store.require('entry', external.entryId);
  store.put('entry', { ...renamed, title: 'Saved external work' });
  assert(flattenTree(service.snapshot(), expanded).some((r) => r.entryId === external.entryId));
  store.close();
});

test('management command suggestions filter prefixes and never offer task execution', async () => {
  const { managementSuggestions } = await import('../dist/management/slash.js');
  assert(managementSuggestions('/').some((c) => c.command === '/usage'));
  assert(managementSuggestions('/').some((c) => c.command === '/accounts'));
  assert.deepEqual(
    managementSuggestions('/u').map((c) => c.command),
    ['/usage'],
  );
  assert.deepEqual(managementSuggestions('/usage --refresh'), []);
  assert.deepEqual(managementSuggestions('a task'), []);
  assert.deepEqual(managementSuggestions('/run'), []);
  assert.deepEqual(managementSuggestions('/plan'), []);
});

test('Copilot quota observations use only account.getQuota and retain only documented quota fields', async () => {
  const native = path.join(root, 'copilot-quota-fixture');
  const capture = path.join(root, 'copilot-quota-methods');
  await writeFile(
    native,
    `#!${process.execPath}
const fs = require('node:fs');let buffer=Buffer.alloc(0);
process.stdin.on('data',chunk=>{ buffer=Buffer.concat([buffer,chunk]);const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;const length=Number(buffer.subarray(0,end).toString().match(/Content-Length: (\\d+)/)[1]);if(buffer.length<end+4+length)return;
const request=JSON.parse(buffer.subarray(end+4,end+4+length));fs.appendFileSync(${JSON.stringify(capture)}, request.method+'\\n');
const result=request.method==='auth.getStatus'?{isAuthenticated:true,login:'quota-fixture'}:{quotaSnapshots:{premium_interactions:{remainingPercentage:75,entitlementRequests:200,usedRequests:50,resetDate:'2026-11-01T00:00:00Z',token:'PRIVATE-QUOTA'},bad:{remainingPercentage:200},unlimited:{isUnlimitedEntitlement:true,entitlementRequests:-1,usedRequests:0,remainingPercentage:100}}};
const body=JSON.stringify({jsonrpc:'2.0',id:request.id,result});process.stdout.write('Content-Length: '+Buffer.byteLength(body)+'\\r\\n\\r\\n'+body);});`,
    { mode: 0o700 },
  );
  const { store, service } = fixture();
  service.installations = installs.map((i) =>
    i.tool === 'copilot'
      ? {
          ...i,
          executable: native,
          capabilities: {
            ...i.capabilities,
            resources: cap(true),
            configurationIsolation: cap(true),
          },
        }
      : i,
  );
  try {
    const p = await profile(service, 'copilot', 'quota');
    assert.equal((await service.refreshProfile(p.id)).refreshed, true);
    const resources = service.snapshot().resources;
    assert.equal(resources.length, 2);
    const premium = resources.find((r) => r.bucket === 'premium_interactions');
    assert.equal(premium.value, 75);
    assert.equal(premium.quota.used, 50);
    assert.equal(premium.quota.allowance, 200);
    assert.equal(premium.resetsAt, '2026-11-01T00:00:00.000Z');
    assert(!JSON.stringify(service.snapshot()).includes('PRIVATE-'));
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(capture, 'utf8'), 'auth.getStatus\naccount.getQuota\n');
  } finally {
    store.close();
  }
});

test('callback providers do not report setup failures during polling refresh', async () => {
  const { store, service } = fixture();
  try {
    for (const tool of ['claude', 'antigravity']) {
      // Fixture directories allow safe metadata-only registration for both tools.
      service.installations = installs.map((i) =>
        i.tool === tool
          ? { ...i, capabilities: { ...i.capabilities, configurationIsolation: cap(true) } }
          : i,
      );
      const p =
        tool === 'antigravity'
          ? await service.addProfile({ tool, label: `callback-refresh-${tool}`, isolated: true })
          : await profile(service, tool, `callback-refresh-${tool}`);
      service.failures.set(p.id, { count: 1, next: Date.now() + 60_000 });
      const result = await service.refreshProfile(p.id);
      assert.equal(result.delivery, 'native-callback');
      assert.equal(result.refreshed, false);
      assert.equal(result.reason, undefined);
    }
  } finally {
    store.close();
  }
});

test('empty profile names produce an actionable error and leave registration unchanged', async () => {
  const { store, service } = fixture();
  try {
    await assert.rejects(
      service.addProfile({ tool: 'codex', label: '  ', isolated: true }),
      /Enter a profile name, such as Personal or Other/,
    );
    assert.equal(store.list('profile').length, 0);
  } finally {
    store.close();
  }
});

test('profile rename preserves identity and history, validates names, and removal retains native files', async () => {
  const { store, service } = fixture();
  try {
    const original = await profile(service, 'codex', 'rename-personal');
    const other = await profile(service, 'codex', 'rename-work');
    store.put('conversation', {
      id: 'saved-conversation',
      profileId: original.id,
      tool: 'codex',
      nativeId: 'native-id',
      projectId: 'saved-project',
    });
    store.put('profile', {
      ...original,
      auth: 'authenticated',
      reportedAccount: 'synthetic@example.test',
    });
    const renamed = await service.rpc('profiles.rename', {
      profile: original.id,
      label: '  Personal  ',
    });
    assert.equal(renamed.label, 'Personal');
    assert.equal(renamed.id, original.id);
    assert.equal(renamed.directory, original.directory);
    assert.equal(renamed.auth, 'authenticated');
    assert.equal(store.get('conversation', 'saved-conversation').profileId, renamed.id);
    await assert.rejects(
      service.rpc('profiles.rename', { profile: original.id, label: '' }),
      /Enter a profile name/,
    );
    await assert.rejects(
      service.rpc('profiles.rename', { profile: original.id, label: other.label }),
      /unique/,
    );
    const result = await service.rpc('profiles.remove', { profile: original.id });
    assert.equal(result.credentialsPreserved, true);
    assert.equal(
      service.snapshot().profiles.some((p) => p.id === original.id),
      false,
    );
    assert.ok(service.snapshot().excludedProfiles.some((p) => p.directory === original.directory));
    assert.equal(store.get('conversation', 'saved-conversation').profileId, original.id);
    assert.equal((await stat(original.directory)).isDirectory(), true);
    assert.throws(() => store.profile(original.id), /removed.*Add its existing configuration/);
    const restored = await service.addProfile({
      tool: 'codex',
      label: 'Personal again',
      directory: original.directory,
    });
    assert.equal(restored.id, original.id);
    assert.equal(restored.auth, 'unknown');
  } finally {
    store.close();
  }
});

test('profile removal refuses active and uncertain invocations and in-flight usage refresh', async () => {
  const { store, service } = fixture();
  try {
    const original = await profile(service, 'codex', 'busy-personal');
    for (const lifecycle of ['starting', 'running', 'unknown']) {
      store.put('invocation', { id: 'synthetic-active', profileId: original.id, lifecycle });
      await assert.rejects(
        service.rpc('profiles.remove', { profile: original.id }),
        /active or uncertain/,
      );
      assert.equal(store.profile(original.id).id, original.id);
    }
    store.put('invocation', {
      id: 'synthetic-active',
      profileId: original.id,
      lifecycle: 'exited',
    });
    service.probes.set(original.id, Promise.resolve());
    await assert.rejects(service.rpc('profiles.remove', { profile: original.id }), /usage refresh/);
    service.probes.delete(original.id);
    await service.rpc('profiles.remove', { profile: original.id });
    assert.equal(service.snapshot().profiles.length, 0);
  } finally {
    store.close();
  }
});

test('dismissing cached account references persists without removing profiles or historical metadata', async () => {
  const file = path.join(managementPaths.state, 'dismissed-accounts.sqlite');
  const { store, service } = fixture(file);
  const retained = await profile(service, 'codex', 'retained-codex');
  const id = '00000000-0000-4000-8000-000000000001';
  const untouched = store.put('conversation', { id: 'retained-history', profileId: retained.id });
  await service.rpc('accounts.dismiss', { ids: [id, id] });
  assert.deepEqual(service.snapshot().dismissedAccountIds, [id]);
  assert.equal(service.snapshot().profiles[0].id, retained.id);
  assert.deepEqual(store.get('conversation', untouched.id), untouched);
  await assert.rejects(service.rpc('accounts.dismiss', { ids: ['invalid'] }));
  store.close();
  const reopened = new ManagementStore(file);
  assert.deepEqual(reopened.dismissedAccountIds(), [id]);
  assert.equal(reopened.profile(retained.id).label, retained.label);
  reopened.close();
});

test('Antigravity callback changes preserve valid fields and omit unsupported quota without rejecting account', async () => {
  const { store, service } = fixture();
  service.installations = installs.map((i) =>
    i.tool === 'antigravity'
      ? { ...i, capabilities: { ...i.capabilities, configurationIsolation: cap(true) } }
      : i,
  );
  const p = await service.addProfile({ tool: 'antigravity', label: 'private-a', isolated: true });
  assert.equal(
    p.directory,
    path.join(managementPaths.profiles, p.id, '.gemini', 'antigravity-cli'),
  );
  const b = await service.addProfile({ tool: 'antigravity', label: 'private-b', isolated: true });
  assert.notEqual(b.directory, p.directory);
  const wrapper = await processIdentity(process.pid);
  const prepared = await service.prepare({ profile: p.id, directory: root, wrapper });
  await assert.rejects(service.prepare({ profile: p.id, directory: root, wrapper }), /one writer/);
  const other = await service.prepare({ profile: b.id, directory: root, wrapper });
  assert.notEqual(other.invocation.id, prepared.invocation.id);
  store.put('invocation', { ...prepared.invocation, identity: wrapper, lifecycle: 'running' });
  const callback = normalizeStatusline(
    'antigravity',
    {
      email: 'private@example.test',
      conversation_id: 42,
      session_id: 'valid-fallback',
      future_field: { opaque: true },
      quota: { valid: { remaining_fraction: 0.25 }, invalid: { remaining_fraction: 2 } },
    },
    [process.pid],
    prepared.invocation.id,
  );
  assert.equal(callback.conversationId, 'valid-fallback');
  assert.equal(callback.resources.length, 1);
  assert.equal(callback.resources[0].value, 25);
  assert.equal(callback.warnings.length, 1);
  await service.observe(callback);
  assert.equal(store.profile(p.id).auth, 'authenticated');
  assert.equal(store.profile(p.id).observationWarnings.length, 1);
  const malformed = normalizeStatusline(
    'antigravity',
    { email: 'private@example.test', quota: 'changed' },
    [process.pid],
    prepared.invocation.id,
  );
  assert.equal(malformed.resources.length, 0);
  assert.match(malformed.warnings[0], /Quota format changed/);
  await service.observe(malformed);
  await service.observe(
    normalizeStatusline(
      'antigravity',
      { email: 'private@example.test', quota: { valid: { remaining_fraction: 0.5 } } },
      [process.pid],
      prepared.invocation.id,
    ),
  );
  assert.deepEqual(store.profile(p.id).observationWarnings, []);
  // Native exit alone must not release a profile while its private runtime is still flushing.
  const saved = service.snapshot().invocations.find((i) => i.id === prepared.invocation.id);
  store.put('invocation', {
    ...saved,
    identity: { ...wrapper, startTime: 'invalidated-test-identity' },
    runtimeIdentity: wrapper,
  });
  await service.tick();
  assert.notEqual(
    service.snapshot().invocations.find((i) => i.id === saved.id).lifecycle,
    'exited',
  );
  await assert.rejects(service.prepare({ profile: p.id, directory: root, wrapper }), /one writer/);
  store.put('invocation', {
    ...store.require('invocation', saved.id),
    runtimeIdentity: { ...wrapper, startTime: 'invalidated-runtime-identity' },
  });
  await service.tick();
  assert.equal(service.snapshot().invocations.find((i) => i.id === saved.id).lifecycle, 'exited');

  store.close();
});

test('reopen rechecks stale process identities without terminating live native processes or guessing ownership', async () => {
  const { store, service } = fixture();
  try {
    const p = await profile(service, 'codex', 'reopen');
    const wrapper = await processIdentity(process.pid);
    const launch = await service.prepare({ profile: p.id, directory: root, wrapper });
    const dead = { ...wrapper, startTime: 'no-longer-this-process' };
    store.put('invocation', { ...launch.invocation, identity: dead, lifecycle: 'running' });
    let plan = await service.reopenPlan({ entry: launch.entry.id });
    assert.equal(plan.mode, 'picker');
    assert.equal(plan.stopInvocationId, null);
    assert.equal(store.require('invocation', launch.invocation.id).lifecycle, 'exited');
    const current = await service.prepare({
      profile: p.id,
      directory: root,
      wrapper,
      entryId: launch.entry.id,
    });
    store.put('invocation', { ...current.invocation, identity: wrapper, lifecycle: 'running' });
    plan = await service.reopenPlan({ entry: launch.entry.id });
    assert.equal(plan.stopInvocationId, current.invocation.id);
    assert.equal(store.require('invocation', current.invocation.id).stopRequestedAt, undefined);
    assert.equal(await identityMatches(wrapper), true);
    store.put('invocation', {
      ...store.require('invocation', current.invocation.id),
      wrapper: dead,
    });
    await assert.rejects(
      service.reopenPlan({ entry: launch.entry.id }),
      /original launcher is unavailable/,
    );
    const external = service.registerExternal({
      tool: 'codex',
      identity: { ...wrapper, startTime: 'synthetic-external-identity' },
      directory: root,
    });
    await assert.rejects(
      service.reopenPlan({ entry: external.entryId }),
      /unassigned process observation/,
    );
  } finally {
    store.close();
  }
});

test(
  'stalled graceful stop requires explicit force recovery and only kills the verified owned child',
  { skip: process.platform !== 'linux', timeout: 10_000 },
  async () => {
    const { store, service } = fixture();
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const exited = once(child, 'exit');
    try {
      await once(child.stdout, 'data');
      const wrapper = await processIdentity(process.pid);
      const identity = await processIdentity(child.pid);
      const p = await profile(service, 'codex', 'stalled-stop');
      const launch = await service.prepare({ profile: p.id, directory: root, wrapper });
      store.put('invocation', { ...launch.invocation, identity, lifecycle: 'running' });
      assert.equal(
        (await service.reopenPlan({ entry: launch.entry.id })).forceStopAvailable,
        false,
      );
      await assert.rejects(service.stop(launch.invocation.id, true), /graceful stop/);
      await service.stop(launch.invocation.id);
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(await identityMatches(identity), true);
      await assert.rejects(service.stop(launch.invocation.id, true), /30 seconds/);
      await assert.rejects(
        forceStopOwned({ ...identity, startTime: 'changed' }, wrapper),
        /Safe force stop failed/,
      );
      await assert.rejects(forceStopOwned(identity, identity), /unavailable/);
      assert.equal(await identityMatches(identity), true);
      store.updateInvocation(launch.invocation.id, {
        stopRequestedAt: new Date(Date.now() - 31_000).toISOString(),
      });
      assert.equal((await service.reopenPlan({ entry: launch.entry.id })).forceStopAvailable, true);
      assert.equal((await service.stop(launch.invocation.id, true)).signal, 'SIGKILL');
      assert.equal((await exited)[1], 'SIGKILL');
      assert.equal(await identityMatches(wrapper), true);
      assert.equal((await service.reopenPlan({ entry: launch.entry.id })).stopInvocationId, null);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      store.close();
    }
  },
);

test('reopen preserves Antigravity keyring leases, uses native continuation only when supported, and blocks other conversations', async () => {
  const { store, service } = fixture();
  service.installations = installs.map((i) =>
    i.tool === 'antigravity'
      ? {
          ...i,
          continueSupported: true,
          capabilities: { ...i.capabilities, configurationIsolation: cap(true) },
        }
      : i,
  );
  try {
    const p = await service.addProfile({
      tool: 'antigravity',
      label: 'reopen-agy',
      isolated: true,
    });
    const wrapper = await processIdentity(process.pid);
    const launch = await service.prepare({ profile: p.id, directory: root, wrapper });
    const dead = { ...wrapper, startTime: 'terminated-native' };
    store.put('invocation', {
      ...launch.invocation,
      identity: dead,
      runtimeIdentity: wrapper,
      lifecycle: 'running',
    });
    let plan = await service.reopenPlan({ entry: launch.entry.id });
    assert.equal(plan.mode, 'latest');
    assert.equal(plan.waitingForExit, true);
    assert.equal(store.require('invocation', launch.invocation.id).lifecycle, 'running');
    store.put('invocation', {
      ...store.require('invocation', launch.invocation.id),
      runtimeIdentity: dead,
    });
    plan = await service.reopenPlan({ entry: launch.entry.id });
    assert.equal(plan.waitingForExit, false);
    const live = await service.prepare({ profile: p.id, directory: root, wrapper });
    store.put('invocation', { ...live.invocation, identity: wrapper, lifecycle: 'running' });
    await assert.rejects(
      service.reopenPlan({ entry: launch.entry.id }),
      /Another conversation is active/,
    );
    store.finish(store.require('invocation', live.invocation.id), 0);
    service.installations = service.installations.map((i) => ({ ...i, continueSupported: false }));
    plan = await service.reopenPlan({ entry: launch.entry.id });
    assert.equal(plan.mode, 'native');
    store.bind(
      { ...store.require('invocation', launch.invocation.id) },
      'native-saved-conversation',
    );
    const bound = store.require('entry', launch.entry.id);
    store.put('conversation', {
      ...store.require('conversation', bound.conversationId),
      nativeResumeVerified: false,
    });
    plan = await service.reopenPlan({ entry: launch.entry.id });
    assert.equal(plan.mode, 'conversation');
    assert.equal(plan.experimentalHistory, true);
  } finally {
    store.close();
  }
});

test('hot swapping switches active profiles, selects best quota headroom, and updates snapshot', async () => {
  const { store, service } = fixture();
  try {
    const codexA = await profile(service, 'codex', 'codex_a');
    const codexB = await profile(service, 'codex', 'codex_b');
    store.put('profile', { ...codexA, auth: 'authenticated', reportedAccount: 'alice@example.com' });
    store.put('profile', { ...codexB, auth: 'authenticated', reportedAccount: 'bob@example.com' });

    // 1. Initial active report
    let activeReport = await service.rpc('profiles.active');
    assert.ok(activeReport.codex);
    assert.equal(activeReport.codex.profiles.length, 2);

    // 2. Explicit swap by profile ID
    const swappedA = await service.rpc('profiles.swap', { tool: 'codex', target: codexA.id });
    assert.equal(swappedA.swapped, true);
    assert.equal(swappedA.current.id, codexA.id);
    assert.equal(service.snapshot().activeProfiles?.codex, codexA.id);

    // 3. Swap by profile label without specifying tool
    const swappedB = await service.rpc('profiles.swap', { target: 'codex_b' });
    assert.equal(swappedB.swapped, true);
    assert.equal(swappedB.tool, 'codex');
    assert.equal(swappedB.current.id, codexB.id);
    assert.equal(service.snapshot().activeProfiles?.codex, codexB.id);

    // 4. Smart quota headroom selection (--best)
    // codexA: 80% used -> 20% headroom
    store.put('resource', {
      id: 'res-codex-a',
      profileId: codexA.id,
      invocationId: null,
      account: 'alice@example.com',
      metric: 'rate-limit-used',
      bucket: 'codex/primary (43200m)',
      value: 80,
      unit: 'percent',
      resetsAt: null,
      source: 'test',
      sourceKind: 'official',
      observedAt: new Date().toISOString(),
    });
    // codexB: 15% used -> 85% headroom
    store.put('resource', {
      id: 'res-codex-b',
      profileId: codexB.id,
      invocationId: null,
      account: 'bob@example.com',
      metric: 'rate-limit-used',
      bucket: 'codex/primary (43200m)',
      value: 15,
      unit: 'percent',
      resetsAt: null,
      source: 'test',
      sourceKind: 'official',
      observedAt: new Date().toISOString(),
    });

    const swappedBest = await service.rpc('profiles.swap', { tool: 'codex', best: true });
    assert.equal(swappedBest.current.id, codexB.id);
    assert.equal(service.profileHeadroom(codexB.id), 85);
    assert.equal(service.profileHeadroom(codexA.id), 20);

    // 5. Antigravity profile swapping and quota evaluation
    service.installations = installs.map((i) =>
      i.tool === 'antigravity'
        ? { ...i, capabilities: { ...i.capabilities, configurationIsolation: cap(true) } }
        : i,
    );
    const antiA = await service.addProfile({ tool: 'antigravity', label: 'anti_a', isolated: true });
    const antiB = await service.addProfile({ tool: 'antigravity', label: 'anti_b', isolated: true });
    store.put('profile', { ...antiA, auth: 'authenticated', reportedAccount: 'anti1@example.com' });
    store.put('profile', { ...antiB, auth: 'authenticated', reportedAccount: 'anti2@example.com' });

    // antiA: 10% remaining weekly
    store.put('resource', {
      id: 'res-anti-a',
      profileId: antiA.id,
      invocationId: null,
      account: 'anti1@example.com',
      metric: 'quota-remaining',
      bucket: 'gemini-weekly',
      value: 10,
      unit: 'percent',
      resetsAt: null,
      source: 'test',
      sourceKind: 'official',
      observedAt: new Date().toISOString(),
    });
    // antiB: 95% remaining weekly
    store.put('resource', {
      id: 'res-anti-b',
      profileId: antiB.id,
      invocationId: null,
      account: 'anti2@example.com',
      metric: 'quota-remaining',
      bucket: 'gemini-weekly',
      value: 95,
      unit: 'percent',
      resetsAt: null,
      source: 'test',
      sourceKind: 'official',
      observedAt: new Date().toISOString(),
    });

    const swappedAntiBest = await service.rpc('profiles.swap', { tool: 'antigravity', best: true });
    assert.equal(swappedAntiBest.current.id, antiB.id);
    assert.equal(service.snapshot().activeProfiles?.antigravity, antiB.id);

    // 6. Unknown profile error
    await assert.rejects(
      service.rpc('profiles.swap', { target: 'nonexistent-profile' }),
      /not found/,
    );
  } finally {
    store.close();
  }
});

test('tool aliases (cdx, agy, cld, cop) normalize correctly and support shortened commands', async () => {
  assert.equal(normalizeTool('cdx'), 'codex');
  assert.equal(normalizeTool('codex'), 'codex');
  assert.equal(normalizeTool('agy'), 'antigravity');
  assert.equal(normalizeTool('antigravity'), 'antigravity');
  assert.equal(normalizeTool('cld'), 'claude');
  assert.equal(normalizeTool('cop'), 'copilot');
  assert.equal(normalizeTool('unknown'), null);

  const { store, service } = fixture();
  service.installations = installs.map((i) => ({
    ...i,
    capabilities: { ...i.capabilities, configurationIsolation: cap(true) },
  }));
  try {
    const codexProfile = await service.addProfile({ tool: 'cdx', label: 'cdx-profile', isolated: true });
    assert.equal(codexProfile.tool, 'codex');
    const agyProfile = await service.addProfile({ tool: 'agy', label: 'agy-profile', isolated: true });
    assert.equal(agyProfile.tool, 'antigravity');

    const swapped = await service.rpc('profiles.swap', { tool: 'cdx', target: 'cdx-profile' });
    assert.equal(swapped.swapped, true);
    assert.equal(swapped.tool, 'codex');
    assert.equal(swapped.current.label, 'cdx-profile');

    const swappedAgy = await service.rpc('profiles.swap', { tool: 'agy', target: 'agy-profile' });
    assert.equal(swappedAgy.swapped, true);
    assert.equal(swappedAgy.tool, 'antigravity');
    assert.equal(swappedAgy.current.label, 'agy-profile');
  } finally {
    store.close();
  }
});

