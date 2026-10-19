import { restoreNativeSettings } from './native-settings.mjs';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFile, readFile, mkdir, chmod, rm, appendFile, rename } from 'node:fs/promises';
import { Conversation } from './conversation.mjs';
import { Codex } from './rpc.mjs';
import { antigravityIdentity } from './antigravity-identity.mjs';
import { redact as sanitize, redactValue } from './redaction.mjs';
import { supportedVersions } from './provider-versions.mjs';
import {
  deniedPermission,
  workspacePermissions,
  completedResult,
} from './antigravity-permissions.mjs';
const root = '/run/principal';
let active = null;
let conversation = null;
let conversationJournal = Promise.resolve();
let seq = 0;
let loginState = null;
async function event(type, data) {
  await appendFile(
    `${root}/events.ndjson`,
    JSON.stringify({
      seq: ++seq,
      type,
      data: redactValue(data),
      at: new Date().toISOString(),
    }) + '\n',
    { mode: 0o600 },
  );
}
async function status(value) {
  await writeFile(`${root}/status.tmp`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${root}/status.tmp`, `${root}/status.json`);
}
function capture(command, args, { input, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(command, args, { cwd: '/workspace', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    const timer = setTimeout(() => c.kill('SIGKILL'), timeout);
    c.stdout.on('data', (b) => {
      stdout += b;
      if (stdout.length > 16 * 1024 * 1024) c.kill('SIGKILL');
    });
    c.stderr.on('data', (b) => {
      stderr += b;
      if (stderr.length > 65536) stderr = stderr.slice(-65536);
    });
    c.on('error', reject);
    c.on('close', (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(stdout)
        : reject(new Error(sanitize(stderr) || `${command} exited ${code}`));
    });
    c.stdin.on('error', () => {});
    c.stdin.end(input);
  });
}
async function configure(m) {
  const manifest = JSON.parse(await readFile('/opt/principal/compatibility.json', 'utf8'));
  const version = manifest.providers[m.provider]?.version?.match(/\d+\.\d+\.\d+/)?.[0];
  if (!supportedVersions[m.provider]?.includes(version))
    throw new Error(
      `Unsupported ${m.provider} version ${version ?? 'unknown'}; update the adapter and protocol reference before using this image`,
    );
  if (m.provider === 'codex') {
    await capture('test', ['-x', '/usr/local/bin/codex-code-mode-host']).catch(() => {
      throw new Error(
        'Runtime image is missing codex-code-mode-host; rebuild it using a complete Codex standalone release.',
      );
    });
  }
  if (m.provider === 'antigravity') {
    const attributes = ['service', 'principal-keyring-check', 'username', 'bootstrap'];
    await capture('secret-tool', ['store', '--label=Principal keyring readiness', ...attributes], {
      input: 'principal-readiness-probe',
    });
    try {
      const probe = await capture('secret-tool', ['lookup', ...attributes]);
      if (probe.trim() !== 'principal-readiness-probe')
        throw new Error('Private keyring read-back failed');
    } finally {
      await capture('secret-tool', ['clear', ...attributes]);
    }
  }
  if (m.native) { await restoreNativeSettings(); return { ok: true }; }
  await mkdir('/home/principal/.codex', { recursive: true });
  await mkdir('/home/principal/.gemini/antigravity-cli', { recursive: true });
  await writeFile(
    '/home/principal/.codex/config.toml',
    'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n[features]\nmulti_agent = false\n' +
      (m.supervisor
        ? '[mcp_servers.principal]\ncommand = "node"\nargs = ["/opt/principal/mcp.mjs"]\n'
        : ''),
    { mode: 0o600 },
  );
  await writeFile(
    '/home/principal/.gemini/antigravity-cli/settings.json',
    JSON.stringify({
      permissions: workspacePermissions(m.permissions, m.workspaceWritable),
    }),
    { mode: 0o600 },
  );
  return { ok: true };
}
async function inspect(m) {
  if (m.provider === 'codex') {
    const rpc = new Codex();
    try {
      await rpc.init();
      return await rpc.request(m.method, m.params ?? {});
    } finally {
      await rpc.stop();
    }
  }
  if (m.method === 'models') {
    const text = await capture('agy', ['models']);
    return {
      data: text
        .split('\n')
        .map((line) => line.trim().match(/^([a-z][a-z0-9.-]+)\s+(.+)$/))
        .filter(Boolean)
        .map((row) => ({ id: row[1], label: row[2] })),
    };
  }
  const command = m.method === 'models' ? '/model' : m.method === 'identity' ? '/usage' : '/usage';
  const text = await capture('agy', [
    '--output-format',
    'json',
    '--print-timeout',
    '30s',
    '-p',
    command,
  ]);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Unsupported Antigravity JSON response');
  }
}
async function run(m) {
  const current = {
    attemptId: m.attemptId,
    state: 'running',
    sessionId: null,
    result: null,
    error: null,
    providerError: null,
  };
  await status(current);
  let timer;
  let denied = false;
  let journal = Promise.resolve();
  const emit = (type, data) => {
    journal = journal.then(() => event(type, data));
  };
  try {
    for (const argv of m.setup ?? []) {
      await capture(argv[0], argv.slice(1), { timeout: 300000 });
    }
    if (m.provider === 'codex') {
      const rpc = new Codex();
      active = {
        id: m.attemptId,
        cancel: async () => {
          if (current.sessionId && active.turnId)
            await rpc.request('turn/interrupt', {
              threadId: current.sessionId,
              turnId: active.turnId,
            });
          await rpc.stop();
        },
        rpc,
      };
      rpc.on('denied', (method) => {
        denied = true;
        emit('approval_denied', { method });
      });
      let finalMessage = '';
      rpc.on('item/completed', (p) => {
        if (p.item?.type === 'agentMessage') finalMessage = p.item.text ?? finalMessage;
        else
          emit('tool', {
            type: p.item?.type,
            command: p.item?.command,
            state: p.item?.status ?? 'completed',
          });
      });
      rpc.on('item/agentMessage/delta', (p) => emit('text_delta', { text: p.delta }));
      rpc.on('item/started', (p) =>
        emit('tool', { type: p.item?.type, command: p.item?.command, state: 'running' }),
      );
      rpc.on('thread/tokenUsage/updated', (p) => emit('usage', p));
      rpc.on('account/rateLimits/updated', (p) => emit('quota', p));
      await rpc.init();
      const thread = await rpc.request(m.resumeSession ? 'thread/resume' : 'thread/start', {
        ...(m.resumeSession ? { threadId: m.resumeSession } : {}),
        cwd: '/workspace',
        model: m.model ?? null,
        approvalPolicy: 'never',
        // The enclosing Docker container enforces filesystem access. Nested bwrap
        // cannot create namespaces under Docker's default seccomp policy.
        sandbox: 'danger-full-access',
        ...(m.resumeSession ? { excludeTurns: true } : { ephemeral: false }),
        config: { 'features.multi_agent': false },
      });
      current.sessionId = thread.thread.id;
      await status(current);
      emit('session', { sessionId: current.sessionId });
      const completed = rpc.wait('turn/completed', m.timeoutSeconds * 1000);
      completed.catch(() => {});
      const started = await rpc.request('turn/start', {
        threadId: current.sessionId,
        sandboxPolicy: { type: 'externalSandbox', networkAccess: 'enabled' },
        input: [{ type: 'text', text: m.prompt }],
        outputSchema: m.outputSchema,
      });
      active.turnId = started.turn.id;
      const final = await completed;
      const messages = final.turn.items?.filter((i) => i.type === 'agentMessage') ?? [];
      const finalItem =
        messages.filter((i) => i.phase === 'final_answer').at(-1) ?? messages.at(-1);
      current.result = finalItem?.text || finalMessage;
      current.state = final.turn.status === 'completed' && !denied ? 'completed' : 'failed';
      current.providerError = denied ? null : (final.turn.error ?? null);
      current.error = denied
        ? 'Required permission was denied'
        : final.turn.error
          ? JSON.stringify(final.turn.error)
          : current.state === 'failed'
            ? `Turn ${final.turn.status}`
            : null;
      await rpc.stop();
    } else {
      const args = [
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--print-timeout',
        `${m.timeoutSeconds}s`,
        '--json-schema',
        JSON.stringify(m.outputSchema),
      ];
      if (m.model) args.push('--model', m.model);
      if (m.resumeSession) args.push('--conversation', m.resumeSession);
      if (m.mode === 'read') args.push('--mode', 'plan');
      const child = spawn('agy', args, {
        cwd: '/workspace',
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      active = {
        id: m.attemptId,
        cancel: async () => {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {}
        },
      };
      let errorText = '';
      let final = null;
      let timedOut = false;
      timer = setTimeout(
        () => {
          timedOut = true;
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        },
        m.timeoutSeconds * 1000 + 5000,
      );
      child.stderr.on('data', (b) => {
        errorText = (errorText + b.toString()).slice(-8000);
      });
      createInterface({ input: child.stdout }).on('line', (line) => {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          return;
        }
        if (e.event === 'init') {
          current.sessionId = e.conversation_id;
          emit('session', { sessionId: current.sessionId });
        }
        if (e.event === 'step_update') {
          const s = e.step_update;
          if (s.text_delta) emit('text_delta', { text: s.text_delta });
          if (s.step_type === 'tool')
            emit('tool', { type: s.tool_name ?? s.step_type, state: s.state });
        }
        if (e.event === 'result') {
          final = e.result;
          child.stdin.end();
          const baseline = m.previousUsage ?? {};
          const delta = {};
          for (const [key, value] of Object.entries(final.usage ?? {})) {
            if (typeof value === 'number')
              delta[key] = value >= (baseline[key] ?? 0) ? value - (baseline[key] ?? 0) : null;
          }
          emit('usage', { cumulative: true, usage: final.usage, delta });
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.write(JSON.stringify({ event: 'user', message: { content: m.prompt } }) + '\n');
      const code = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
      denied = denied || deniedPermission(errorText);
      if (denied) emit('approval_denied', { method: 'antigravity/native-policy' });
      current.state =
        !timedOut && !denied && completedResult(code, final, errorText) ? 'completed' : 'failed';
      current.result = final?.structured_output ?? final?.response ?? null;
      current.providerError = !denied && typeof final?.error === 'object' ? final.error : null;
      current.error =
        current.state === 'failed'
          ? sanitize(
              (timedOut ? `Antigravity attempt timed out after ${m.timeoutSeconds}s` : errorText) ||
                (denied ? 'Required tool permission was denied' : final?.error) ||
                JSON.stringify(final ?? { exitCode: code }),
            )
          : null;
    }
  } catch (e) {
    current.state = 'failed';
    current.error = sanitize(e.message);
    current.providerError = e.providerError ?? null;
    try {
      await active?.cancel();
    } catch {}
  } finally {
    clearTimeout(timer);
    active = null;
    await journal;
    await event('terminal', { state: current.state, error: current.error });
    await status(current);
  }
}
async function conversationRun(m) {
  const current = {
    attemptId: m.attemptId,
    state: 'running',
    sessionId: conversation?.nativeId ?? null,
    result: null,
    error: null,
  };
  await status(current);
  try {
    if (!conversation) {
      conversation = new Conversation(
        m.provider,
        (type, data) => {
          conversationJournal = conversationJournal.then(() => event(type, data));
        },
        (data) => {
          conversationJournal = conversationJournal.then(() => event('question', data));
        },
      );
      await conversation.open(m);
    }
    active = { id: m.attemptId, cancel: () => conversation.interrupt() };
    Object.assign(current, await conversation.send(m));
  } catch (e) {
    current.state = 'failed';
    current.error = sanitize(e.message);
  } finally {
    active = null;
    await conversationJournal;
    await event('terminal', { state: current.state, error: current.error });
    await status(current);
  }
}
await mkdir(root, { recursive: true });
await rm(`${root}/helper.sock`, { force: true });
const server = createServer({ allowHalfOpen: true }, (socket) => {
  let input = '';
  socket.on('data', (b) => {
    input += b;
    if (input.length > 1024 * 1024) socket.destroy();
  });
  socket.on('end', async () => {
    try {
      const m = JSON.parse(input);
      let result;
      if (m.op === 'configure') result = await configure(m);
      else if (m.op === 'login_start') {
        if (active) throw new Error('Account busy');
        const rpc = new Codex();
        await rpc.init();
        loginState = { state: 'pending', error: null };
        active = { cancel: async () => rpc.stop(), rpc };
        rpc.once('account/login/completed', async (p) => {
          loginState = { state: 'settling', error: null };
          await rpc.stop();
          loginState = { state: p.success ? 'completed' : 'failed', error: p.error };
          active = null;
        });
        rpc.once('closed', () => {
          if (loginState.state === 'pending')
            loginState = { state: 'failed', error: 'Login connection closed' };
          active = null;
        });
        result = await rpc.request('account/login/start', { type: 'chatgptDeviceCode' });
      } else if (m.op === 'login_status') result = loginState;
      else if (m.op === 'identity') {
        result = await antigravityIdentity(capture);
      } else if (m.op === 'inspect') {
        if (active) throw new Error('Account busy');
        result = await inspect(m);
      } else if (m.op === 'conversation_start') {
        if (active) throw new Error('Account busy');
        active = { id: m.attemptId, cancel: async () => conversation?.interrupt() };
        await status({ attemptId: m.attemptId, state: 'starting' });
        void conversationRun(m);
        result = { accepted: true };
      } else if (m.op === 'steer')
        result = conversation
          ? await conversation.steer(m)
          : { supported: false, delivery: 'queue' };
      else if (m.op === 'answer') result = await conversation.answer(m);
      else if (m.op === 'compact') {
        if (active) throw new Error('Account busy');
        active = { cancel: () => conversation.shutdown() };
        try {
          result = await conversation.compact();
        } finally {
          active = null;
        }
      } else if (m.op === 'conversation_shutdown') {
        await conversation?.shutdown();
        conversation = null;
        result = { ok: true };
      } else if (m.op === 'start') {
        if (active) throw new Error('Account busy');
        seq = 0;
        await writeFile(`${root}/events.ndjson`, '', { mode: 0o600 });
        await status({ attemptId: m.attemptId, state: 'starting' });
        active = { id: m.attemptId, cancel: async () => {} };
        void run(m);
        result = { accepted: true };
      } else if (m.op === 'status') {
        const events = (await readFile(`${root}/events.ndjson`, 'utf8').catch(() => ''))
          .split('\n')
          .filter(Boolean)
          .map((s) => JSON.parse(s))
          .filter((e) => e.seq > (m.after ?? 0))
          .slice(0, 1000);
        result = {
          status: JSON.parse(await readFile(`${root}/status.json`, 'utf8').catch(() => 'null')),
          events,
        };
      } else if (m.op === 'cancel') {
        await active?.cancel();
        result = { ok: true };
      } else throw new Error('Unknown helper operation');
      socket.end(JSON.stringify({ result }));
    } catch (e) {
      socket.end(
        JSON.stringify({
          error: sanitize(e.message),
          providerError: redactValue(e.providerError ?? null),
        }),
      );
    }
  });
});
server.listen(`${root}/helper.sock`, () => chmod(`${root}/helper.sock`, 0o600));
