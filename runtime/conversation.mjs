import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Codex } from './rpc.mjs';
import { completedResult, deniedPermission } from './antigravity-permissions.mjs';
export class Conversation {
  constructor(provider, emit, requestQuestion, options = {}) {
    this.options = options;
    this.provider = provider;
    this.emit = emit;
    this.requestQuestion = requestQuestion;
    this.nativeId = null;
    this.turnId = null;
    this.pending = null;
    this.questions = new Map();
  }
  capabilities() {
    return {
      steer: this.provider === 'codex',
      compact: this.provider === 'codex',
      questions: this.provider === 'codex' ? 'native' : 'structured',
      resume: true,
    };
  }
  async open(m) {
    this.model = m.model;
    if (this.provider === 'codex') {
      this.rpc = new Codex(this.options);
      this.rpc.on('server_request', (q) => {
        if (q.method === 'item/tool/requestUserInput') {
          this.questions.set(String(q.id), q);
          this.requestQuestion({ id: `native:${q.id}`, params: q.params });
        } else {
          // Native policy remains coordinator-owned. Ask-user-input is distinct from permission grants.
          const result =
            q.method === 'item/commandExecution/requestApproval'
              ? { decision: 'decline' }
              : q.method === 'item/fileChange/requestApproval'
                ? { decision: 'decline' }
                : q.method === 'item/permissions/requestApproval'
                  ? { permissions: {}, scope: 'turn' }
                  : null;
          this.rpc.send(
            result
              ? { id: q.id, result }
              : { id: q.id, error: { code: -32601, message: 'Unsupported interactive request' } },
          );
          this.emit('approval_denied', { method: q.method });
        }
      });
      this.rpc.on('item/agentMessage/delta', (p) => this.emit('text_delta', { text: p.delta }));
      this.rpc.on('item/started', (p) =>
        this.emit('tool', { id: p.item?.id, type: p.item?.type, state: 'running' }),
      );
      this.rpc.on('item/completed', (p) => {
        this.emit('item_completed', p);
        if (p.item?.type === 'agentMessage') this.finalMessage = p.item.text ?? this.finalMessage;
      });
      this.rpc.on('thread/tokenUsage/updated', (p) => this.emit('usage', p));
      this.rpc.on('account/rateLimits/updated', (p) => this.emit('quota', p));
      await this.rpc.init();
      const result = await this.rpc.request(m.resumeSession ? 'thread/resume' : 'thread/start', {
        ...(m.resumeSession ? { threadId: m.resumeSession } : {}),
        cwd: '/workspace',
        model: m.model ?? null,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        config: { 'features.multi_agent': false },
        ...(m.resumeSession ? { excludeTurns: true } : { ephemeral: false }),
      });
      this.nativeId = result.thread.id;
      this.emit('session', { sessionId: this.nativeId });
    } else {
      const args = [
        '--effort',
        'medium',
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
      this.child = spawn(this.options.command ?? 'agy', args, {
        cwd: this.options.cwd ?? '/workspace',
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      this.stderr = '';
      this.child.stderr.on('data', (b) => {
        this.stderr = (this.stderr + b.toString()).slice(-8192);
      });
      this.child.stdin.on('error', (e) => this.fail(e));
      this.child.on('error', (e) => this.fail(e));
      this.child.on('close', (code) => {
        this.closed = true;
        this.fail(new Error(`Antigravity closed before turn result (${code}): ${this.stderr}`));
      });
      createInterface({ input: this.child.stdout }).on('line', (line) => {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          return;
        }
        if (e.event === 'init') {
          this.nativeId = e.conversation_id;
          this.emit('session', { sessionId: this.nativeId });
        }
        if (e.event === 'step_update') {
          const step = e.step_update;
          if (step?.step_type && ['user_input', 'agent_response', 'checkpoint'].includes(step.step_type)) {
            const key = `${step.step_type}:${step.state}`;
            if (this.lastActivity !== key) {
              this.lastActivity = key;
              this.emit('activity', { action: step.step_type === 'agent_response' ? 'Preparing response' : step.step_type === 'checkpoint' ? 'Saving conversation' : 'Input received', state: step.state });
            }
          }
          if (e.step_update?.text_delta)
            this.emit('text_delta', { text: e.step_update.text_delta });
          if (e.step_update?.step_type === 'tool')
            this.emit('tool', {
              type: e.step_update.tool_name ?? 'tool',
              state: e.step_update.state,
              info: e.step_update.tool_info ?? null,
            });
        }
        if (e.event === 'result' && this.pending) {
          const p = this.pending;
          this.pending = null;
          clearTimeout(p.timer);
          const r = e.result;
          this.nativeId = r?.conversation_id ?? this.nativeId;
          this.emit('usage', { cumulative: true, usage: r?.usage });
          if (!deniedPermission(this.stderr) && completedResult(0, r, this.stderr))
            p.resolve({
              state: 'completed',
              result: r.structured_output ?? r.response,
              sessionId: this.nativeId,
            });
          else
            p.resolve({
              state: 'failed',
              result: null,
              error: r?.error ?? this.stderr,
              sessionId: this.nativeId,
            });
        }
      });
    }
    return { nativeId: this.nativeId, capabilities: this.capabilities() };
  }
  fail(e) {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(e);
      this.pending = null;
    }
  }
  async send(m) {
    if (this.pending || this.turnId)
      throw new Error('Native conversation already has an active turn');
    if (this.provider === 'codex') {
      this.finalMessage = '';
      const completed = this.rpc.wait('turn/completed', m.timeoutSeconds * 1000);
      completed.catch(() => {});
      try {
        const started = await this.rpc.request('turn/start', {
          threadId: this.nativeId,
          sandboxPolicy: { type: 'externalSandbox', networkAccess: 'enabled' },
          input: [{ type: 'text', text: m.prompt }],
          outputSchema: m.outputSchema,
        });
        this.turnId = started.turn.id;
        this.emit('native_turn', { turnId: this.turnId });
        const r = await completed;
        const messages = r.turn.items?.filter((i) => i.type === 'agentMessage') ?? [];
        const result = messages.filter((i) => i.phase === 'final_answer').at(-1) ?? messages.at(-1);
        return {
          state: r.turn.status === 'completed' ? 'completed' : 'failed',
          result: result?.text ?? this.finalMessage,
          error: r.turn.error ?? null,
          providerError: r.turn.error ?? null,
          sessionId: this.nativeId,
        };
      } finally {
        this.turnId = null;
      }
    }
    if (this.closed) throw new Error('Antigravity conversation process is closed');
    this.lastActivity = null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.fail(new Error('Antigravity turn timed out'));
          void this.shutdown();
        },
        m.timeoutSeconds * 1000 + 5000,
      );
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(
        JSON.stringify({ event: 'user', message: { content: m.prompt } }) + '\n',
      );
    });
  }
  async steer(m) {
    if (this.provider !== 'codex') return { supported: false, delivery: 'queue' };
    if (!this.turnId) return { supported: false, delivery: 'queue' };
    return {
      supported: true,
      ...(await this.rpc.request('turn/steer', {
        threadId: this.nativeId,
        expectedTurnId: this.turnId,
        clientUserMessageId: m.clientMessageId,
        input: [{ type: 'text', text: m.input }],
      })),
    };
  }
  async answer(m) {
    const q = this.questions.get(m.questionId);
    if (!q) throw new Error('Unknown native question');
    this.rpc.send({ id: q.id, result: { answers: m.answers } });
    this.questions.delete(m.questionId);
    return { supported: true };
  }
  async compact() {
    if (this.provider !== 'codex') return { supported: false };
    if (this.turnId) throw new Error('Cannot compact during a turn');
    const completed = new Promise((resolve, reject) => {
      const listener = (p) => {
        if (p.item?.type === 'contextCompaction') {
          cleanup();
          resolve(p);
        }
      };
      const closed = (e) => {
        cleanup();
        reject(e);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Native compaction timed out'));
      }, 120000);
      const cleanup = () => {
        clearTimeout(timer);
        this.rpc.off('item/completed', listener);
        this.rpc.off('closed', closed);
      };
      this.rpc.on('item/completed', listener);
      this.rpc.once('closed', closed);
    });
    completed.catch(() => {});
    await this.rpc.request('thread/compact/start', { threadId: this.nativeId });
    await completed;
    return { supported: true };
  }
  async interrupt() {
    if (this.provider === 'codex' && this.turnId)
      await this.rpc.request('turn/interrupt', { threadId: this.nativeId, turnId: this.turnId });
    else if (this.provider === 'antigravity') await this.shutdown();
    return { supported: true };
  }
  async shutdown() {
    if (this.rpc) await this.rpc.stop();
    if (this.child && !this.closed) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            process.kill(-this.child.pid, 'SIGKILL');
          } catch {}
        }, 2000);
        this.child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          process.kill(-this.child.pid, 'SIGTERM');
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    }
  }
}
