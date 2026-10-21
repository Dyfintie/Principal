import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { exec, redact } from '../util.js';
import { buildNativeLaunch } from './providers.js';
import { isolatedAntigravityLaunch } from './antigravity-isolation.js';
import { identityMatches, processIdentity } from './process.js';
import { signalWorkerProcesses } from './worker-process.js';
import type { Installation, ProcessIdentity } from './model.js';
import { NativeId } from './model.js';
import type { WorkerCapabilities, WorkerSpec } from './worker-model.js';

export function providerFailure(message: string) {
  const category = /\b401\b|unauthori[sz]ed|authentication|not authenticated|invalid.*token/i.test(message) ? 'authentication'
    : /\b429\b|rate.?limit|quota|too many requests/i.test(message) ? 'rate-limit'
      : /network|connection|dns|unreachable/i.test(message) ? 'network'
        : /permission|\b403\b|forbidden/i.test(message) ? 'permission'
          : /unsupported.*model|invalid.*model|model.*(?:unavailable|not supported)|reasoning|effort|capability failure/i.test(message) ? 'capability' : 'provider';
  return { category, message: `${category} failure; inspect the native profile and worker events` };
}

export async function inspectWorkerCapabilities(installation: Installation): Promise<WorkerCapabilities> {
  const no = (reason: string): WorkerCapabilities => ({ execution: false, stream: false, resume: false, steer: false, model: false, effort: [], reason });
  if (!installation.executable || !['codex', 'antigravity', 'copilot'].includes(installation.tool)) return no('Controlled workers currently support Codex, Antigravity, and Copilot');
  try {
    const result = await exec(installation.executable, ['--help'], { timeout: 5000, maxBytes: 128 * 1024 });
    // Native CLIs (including agy) may print successful help to stderr.
    const help = result.stdout.toString() + '\n' + result.stderr.toString();
    if (installation.tool === 'codex') {
      if (!installation.verifiedVersion || !help.includes('app-server')) return no('A compatible Codex app-server interface is required');
      return { execution: true, stream: true, resume: true, steer: true, model: true, effort: ['low', 'medium', 'high', 'xhigh'], reason: 'Compatible Codex app-server; model and effort acceptance is checked by the provider' };
    }
    if (installation.tool === 'copilot') {
      if (!installation.verifiedVersion || !help.includes('--no-auto-update') || !help.includes('--output-format'))
        return no('A verified Copilot SDK stdio interface is required');
      return { execution: true, stream: true, resume: true, steer: false, model: true,
        effort: help.includes('--reasoning-effort') ? ['low', 'medium', 'high', 'xhigh', 'max'] : [],
        reason: 'Copilot SDK protocol 3, checked on startup; native account selection, queued follow-ups, no live steering. Model and effort acceptance is checked by Copilot' };
    }
    const stream = help.includes('--input-format') && help.includes('--output-format') && help.includes('stream-json');
    const effortLine = help.split('\n').find((line) => line.includes('--effort')) ?? '';
    const effort = ['low', 'medium', 'high', 'xhigh', 'max'].filter((value) => new RegExp(`\\b${value}\\b`).test(effortLine));
    return { execution: stream, stream, resume: help.includes('--conversation'), steer: false, model: help.includes('--model'), effort, reason: stream ? 'Native stream-json; follow-ups are queued between turns, live steering is unsupported' : 'Install Antigravity with stream-json input and output support' };
  } catch { return no('Native interface inspection failed; no inference was started'); }
}

export interface ProviderHooks {
  activity: (kind: string, data?: Record<string, unknown>) => void;
  session: (id: string, model?: string) => void;
  turnId: (id: string) => void;
  result: (status: 'completed' | 'failed' | 'interrupted', error?: { category: string; message: string }) => void;
  exited: (code: number | null) => void;
  identity: (identity: ProcessIdentity) => void;
  owned: (identities: ProcessIdentity[]) => void;
  isolation: (directory: string) => void;
  launching: () => void;
}

/** Separate from codexRead: this transport intentionally owns inference turns. */
export class WorkerProvider {
  child?: ChildProcess;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 0;
  private cleanup?: () => Promise<void>;
  private closed?: Promise<void>;
  private stderr = '';
  private sessionId?: string;
  private turnId?: string;
  private identity?: ProcessIdentity;
  private descendants = new Map<number, ProcessIdentity>();
  private tracking?: ReturnType<typeof setInterval>;
  private dead = false;
  private stopRequested = false;
  private progressKeys = new Set<string>();

  constructor(private readonly spec: WorkerSpec, private readonly hooks: ProviderHooks) {}

  async start(nativeSessionId?: string) {
    const { profile, installation, options, record } = this.spec;
    const args = profile.tool === 'codex'
      ? ['app-server', '--listen', 'stdio://']
      : profile.tool === 'copilot' ? ['--headless', '--stdio', '--no-auto-update', '--log-level', 'none']
      : ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '0', '--dangerously-skip-permissions', '--mode', 'accept-edits',
        ...(nativeSessionId ? ['--conversation', nativeSessionId] : []),
        ...(options.model ? ['--model', options.model] : []), ...(options.effort ? ['--effort', options.effort] : [])];
    const base = buildNativeLaunch(profile, installation, args);
    // A runner must not inherit the lead's callback identity.
    delete base.env.PRINCIPAL_INVOCATION_ID;
    const spec = profile.tool === 'antigravity' && profile.isolated
      ? await isolatedAntigravityLaunch(profile, base)
      : { ...base, trackNativePid: false, keyringPassword: undefined, cleanup: undefined };
    this.cleanup = spec.cleanup;
    if (spec.trackNativePid && spec.env.XDG_RUNTIME_DIR) this.hooks.isolation(spec.env.XDG_RUNTIME_DIR);
    if (this.stopRequested) { await this.cleanup?.(); throw new Error('Worker startup was cancelled'); }
    this.hooks.launching();
    const child = this.child = spawn(spec.executable, [...spec.args], {
      cwd: record.workspace!.workingDir, env: spec.env,
      // Descendants inherit this owned process group; the runner stays outside it.
      detached: true,
      stdio: spec.trackNativePid ? ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    });
    this.closed = new Promise((resolve) => child.once('close', () => resolve()));
    child.on('error', () => this.failTransport('Provider process failed to start'));
    child.stdin!.on('error', () => this.failTransport('Provider input disconnected'));
    child.once('close', (code) => {
      this.dead = true;
      this.failTransport(this.stderr || 'Provider exited before completing the protocol');
      this.hooks.exited(code);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-16 * 1024);
      // Raw stderr may contain auth payloads. Expose a classification, never its body.
      this.hooks.activity('diagnostic', providerFailure(this.stderr));
    });
    if (profile.tool === 'copilot') {
      // SDK transport uses UTF-8 byte lengths, not line-delimited JSON.
      let buffer = Buffer.alloc(0);
      let failed = false;
      child.stdout!.on('data', (chunk: Buffer) => {
        if (failed) return;
        buffer = Buffer.concat([buffer, chunk]);
        try {
          for (;;) {
            const end = buffer.indexOf('\r\n\r\n');
            if (end < 0) { if (buffer.length > 8192) throw new Error(); return; }
            if (end > 8192) throw new Error();
            const headers = buffer.subarray(0, end).toString();
            const matches = [...headers.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)];
            const length = matches.length === 1 ? Number(matches[0][1]) : NaN;
            if (!Number.isSafeInteger(length) || length < 1 || length > 1024 * 1024) throw new Error();
            if (buffer.length < end + 4 + length) return;
            const body = buffer.subarray(end + 4, end + 4 + length).toString();
            buffer = buffer.subarray(end + 4 + length);
            this.receive(body);
          }
        } catch {
          failed = true;
          this.failTransport('Malformed Copilot framing');
          this.hooks.result('failed', { category: 'protocol', message: 'Malformed Copilot framing' });
        }
      });
    } else {
      // Bound an individual NDJSON record before readline buffers it.
      let lineBytes = 0;
      child.stdout!.on('data', (chunk: Buffer) => {
        for (const byte of chunk) {
          lineBytes = byte === 10 ? 0 : lineBytes + 1;
          if (lineBytes > 1024 * 1024) {
            this.failTransport('Provider protocol record exceeded limit');
            child.kill('SIGTERM');
            break;
          }
        }
      });
      const lines = createInterface({ input: child.stdout! });
      lines.on('line', (line) => this.receive(line));
    }
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    this.identity = await processIdentity(child.pid!) ?? undefined;
    if (!this.identity) throw new Error('Provider exited during startup');
    this.hooks.identity(this.identity);
    this.tracking = setInterval(() => { void this.trackDescendants().catch(() => this.hooks.activity('diagnostic', { category: 'ownership', message: 'Process observation failed; cleanup will verify ownership again' })); }, 250);
    if (spec.trackNativePid) {
      const password = spec.keyringPassword;
      const fd3 = child.stdio[3] as Writable;
      fd3.on('error', () => {});
      fd3.end(password, () => password?.fill(0));
      const fd4 = child.stdio[4] as Readable;
      // Do not discard the native PID; record it for ownership-safe recovery.
      let report = '';
      fd4.on('data', (chunk) => {
        report += chunk.toString();
        if (report.length > 128) return child.kill('SIGTERM');
        if (report.includes('\n')) {
          try {
            const pid = JSON.parse(report).pid;
            if (Number.isSafeInteger(pid) && pid > 1) void processIdentity(pid).then((id) => { if (id) this.descendants.set(pid, id); });
          } catch { child.kill('SIGTERM'); }
        }
      });
    }
    if (profile.tool === 'copilot') {
      const ping = await this.rpc('ping', {});
      if (ping?.protocolVersion !== 3) throw new Error('Capability failure: unsupported Copilot SDK protocol version');
      // Bind before creating the session so early events can be correlated.
      this.sessionId = nativeSessionId ?? record.id;
      const result = await this.rpc(nativeSessionId ? 'session.resume' : 'session.create', {
        sessionId: this.sessionId, clientName: 'principal_worker',
        workingDirectory: record.workspace!.workingDir, streaming: true,
        requestPermission: true, requestUserInput: false,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { reasoningEffort: options.effort } : {}),
      });
      if (result?.sessionId !== this.sessionId) throw new Error('Copilot returned an unexpected native session ID');
      this.hooks.session(this.sessionId!);
    }
    if (profile.tool === 'codex') {
      await this.rpc('initialize', { clientInfo: { name: 'principal_worker', title: 'Principal worker', version: '0.2.0' }, capabilities: {} });
      this.write({ method: 'initialized' });
      const parameters = { cwd: record.workspace!.workingDir, ...(options.model ? { model: options.model } : {}), approvalPolicy: 'never', sandbox: 'danger-full-access' };
      const result = await this.rpc(nativeSessionId ? 'thread/resume' : 'thread/start', { ...parameters, ...(nativeSessionId ? { threadId: nativeSessionId, excludeTurns: true } : {}) });
      if (!NativeId.safeParse(result?.thread?.id).success) throw new Error('Codex returned no valid native thread ID');
      this.sessionId = result.thread.id;
      this.hooks.session(this.sessionId!, typeof result.model === 'string' ? result.model.slice(0, 160) : undefined);
    }
  }

  async turn(message: string, requestId: string) {
    this.progressKeys.clear();
    if (this.spec.profile.tool === 'antigravity') {
      this.write({ event: 'user', message: { content: message } });
    } else if (this.spec.profile.tool === 'copilot') {
      // No immediate mode: native steering has different semantics from Codex.
      this.turnId = requestId;
      const result = await this.rpc('session.send', { sessionId: this.sessionId, prompt: message, mode: 'enqueue' });
      if (!NativeId.safeParse(result?.messageId).success) throw new Error('Copilot returned no valid message ID');
    } else {
      const result = await this.rpc('turn/start', { threadId: this.sessionId, clientUserMessageId: requestId, input: [{ type: 'text', text: message, text_elements: [] }], ...(this.spec.options.effort ? { effort: this.spec.options.effort } : {}) });
      if (!NativeId.safeParse(result?.turn?.id).success) throw new Error('Codex returned no valid active turn ID');
      this.turnId = result.turn.id;
      this.hooks.turnId(this.turnId!);
    }
  }

  async steer(message: string, expected: string, requestId: string) {
    if (this.spec.profile.tool !== 'codex') throw new Error('Live steering is unsupported by this provider');
    if (this.turnId !== expected) throw new Error('Active turn changed; inspect the worker before steering');
    await this.rpc('turn/steer', { threadId: this.sessionId, clientUserMessageId: requestId, expectedTurnId: expected, input: [{ type: 'text', text: message, text_elements: [] }] });
  }

  private write(value: unknown) {
    if (this.dead || !this.child?.stdin?.writable) throw new Error('Provider transport is disconnected');
    const body = JSON.stringify(this.spec.profile.tool === 'copilot' ? { jsonrpc: '2.0', ...(value as object) } : value);
    this.child.stdin.write(this.spec.profile.tool === 'copilot'
      ? 'Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body : body + '\n');
  }

  private rpc(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Provider protocol request timed out'));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  private failTransport(message: string) {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(providerFailure(message).message));
    }
    this.pending.clear();
  }

  private receive(line: string) {
    if (!line.trim()) return;
    if (line.length > 1024 * 1024) return;
    let value: any;
    try { value = JSON.parse(line); }
    catch { this.hooks.result('failed', { category: 'protocol', message: 'Malformed provider JSON' }); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      this.hooks.result('failed', { category: 'protocol', message: 'Invalid provider protocol object' }); return;
    }
    if (this.spec.profile.tool === 'copilot') { this.receiveCopilot(value); return; }
    if (this.spec.profile.tool === 'codex') {
      const pending = this.pending.get(value.id);
      if (pending && ('result' in value || 'error' in value)) {
        this.pending.delete(value.id); clearTimeout(pending.timer);
        value.error ? pending.reject(new Error(providerFailure(String(value.error.message ?? '')).message)) : pending.resolve(value.result);
        return;
      }
      // Unexpected provider requests must get a response instead of hanging.
      if (value.id !== undefined && value.method) {
        this.write({ id: value.id, error: { code: -32601, message: 'Interactive provider requests are unsupported by controlled workers' } });
        this.hooks.result('failed', { category: 'permission', message: 'Provider requested interactive input' });
        return;
      }
      const p = value.params ?? {};
      if (value.method === 'turn/started' && NativeId.safeParse(p.turn?.id).success) { this.turnId = p.turn.id; this.hooks.turnId(this.turnId!); }
      else if (value.method === 'turn/completed') {
        if (!this.turnId || p.turn?.id !== this.turnId) {
          this.hooks.activity('diagnostic', { category: 'protocol', message: 'Ignored completion for an unrelated native turn' });
          return;
        }
        const status = p.turn?.status;
        this.turnId = undefined;
        this.hooks.result(status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed', status === 'failed' ? providerFailure(String(p.turn?.error?.message ?? '')) : undefined);
      } else if (value.method === 'item/agentMessage/delta' && typeof p.delta === 'string' && p.delta.length) this.output(p.delta);
      else if (['item/started', 'item/completed', 'item/commandExecution/outputDelta', 'turn/diff/updated'].includes(value.method)) {
        const key = createHash('sha256').update(JSON.stringify([value.method, p.item?.id, p.item?.type, p.itemId, p.delta, p.diff])).digest('hex');
        if (!this.progressKeys.has(key)) {
          if (this.progressKeys.size > 2000) this.progressKeys.clear();
          this.progressKeys.add(key);
          this.hooks.activity('progress', { method: value.method, itemType: typeof p.item?.type === 'string' ? p.item.type.slice(0, 80) : undefined });
        }
        if (value.method === 'item/completed' && p.item?.type === 'agentMessage' && typeof p.item.text === 'string') this.output(p.item.text, 'response');
      }
      else if (value.method === 'error') this.hooks.activity('diagnostic', providerFailure(String(p.error?.message ?? '')));
    } else {
      if (value.event === 'init' && NativeId.safeParse(value.conversation_id).success) {
        this.sessionId = value.conversation_id;
        this.hooks.session(this.sessionId!, typeof value.init?.model === 'string' ? value.init.model.slice(0, 160) : undefined);
      } else if (value.event === 'step_update') {
        const step = value.step_update ?? {};
        const progress = { stepIndex: typeof step.step_index === 'number' ? step.step_index : undefined, state: typeof step.state === 'string' ? step.state.slice(0, 80) : undefined, stepType: typeof step.step_type === 'string' ? step.step_type.slice(0, 80) : undefined };
        const key = JSON.stringify(progress);
        if (!this.progressKeys.has(key)) { if (this.progressKeys.size > 2000) this.progressKeys.clear(); this.progressKeys.add(key); this.hooks.activity('progress', progress); }
        if (step.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta.length) this.output(step.text_delta);
      } else if (value.event === 'result') {
        const result = value.result ?? {};
        if (typeof result.response === 'string') this.output(result.response, 'response');
        if (NativeId.safeParse(result.conversation_id).success) this.hooks.session(result.conversation_id);
        this.hooks.result(result.status === 'SUCCESS' ? 'completed' : ['CANCELED', 'INTERRUPTED'].includes(result.status) ? 'interrupted' : 'failed', result.status === 'SUCCESS' ? undefined : providerFailure(String(result.error ?? result.status)));
      }
    }
  }

  private receiveCopilot(value: any) {
    const pending = this.pending.get(value.id);
    if (pending && ('result' in value || 'error' in value)) {
      this.pending.delete(value.id); clearTimeout(pending.timer);
      value.error ? pending.reject(new Error(providerFailure(String(value.error.message ?? '')).message)) : pending.resolve(value.result);
      return;
    }
    if (value.id !== undefined && value.method) {
      this.write({ id: value.id, error: { code: -32601, message: 'Interactive provider requests are unsupported' } });
      this.hooks.result('failed', { category: 'permission', message: 'Copilot requested interactive input' });
      return;
    }
    const p = value.params;
    if (value.method !== 'session.event' || p?.sessionId !== this.sessionId) return;
    const event = p.event;
    const data = event?.data ?? {};
    if (event?.type === 'permission.requested' && !data.resolvedByHook && typeof data.requestId === 'string') {
      // Return a permission decision, not the past-tense permission.completed result.
      // Copilot CLI 1.0.95 requires approve-once (SDK correction #1315).
      void this.rpc('session.permissions.handlePendingPermissionRequest', {
        sessionId: this.sessionId, requestId: data.requestId, result: { kind: 'approve-once' },
      }).catch(() => this.hooks.result('failed', { category: 'permission', message: 'Copilot permission response failed' }));
    } else if (event?.type === 'assistant.message_delta' && typeof data.deltaContent === 'string') {
      if (this.turnId) this.output(data.deltaContent);
    } else if (event?.type === 'assistant.message' && typeof data.content === 'string') {
      if (this.turnId) this.output(data.content, 'response');
    } else if (event?.type === 'session.error' && this.turnId) {
      this.turnId = undefined;
      this.hooks.result('failed', providerFailure(String(data.message ?? '')));
    } else if (event?.type === 'session.idle' && this.turnId) {
      this.turnId = undefined;
      this.hooks.result(data.aborted ? 'interrupted' : 'completed');
    } else if (['tool.execution_start', 'tool.execution_complete', 'assistant.turn_start'].includes(event?.type) && this.turnId) {
      // Tool arguments/results and private reasoning are deliberately excluded.
      this.hooks.activity('progress', { method: event.type });
    }
  }

  private output(text: string, kind = 'output') {
    const cleaned = redact(text);
    for (let offset = 0; offset < cleaned.length; offset += 8192) {
      this.hooks.activity(kind, { text: cleaned.slice(offset, offset + 8192) });
    }
  }

  private async trackDescendants() {
    const { readFile } = await import('node:fs/promises');
    const roots = [this.identity, ...this.descendants.values()].filter((id): id is ProcessIdentity => !!id);
    for (const root of roots) {
      if (!(await identityMatches(root))) continue;
      const children = await readFile(`/proc/${root.pid}/task/${root.pid}/children`, 'utf8').catch(() => '');
      for (const pid of children.trim().split(/\s+/).filter(Boolean).map(Number)) {
        const id = await processIdentity(pid);
        if (id) this.descendants.set(pid, id);
      }
    }
    this.hooks.owned([...this.descendants.values()]);
  }

  async stop() {
    this.stopRequested = true;
    if (!this.identity && this.child?.pid) this.identity = await processIdentity(this.child.pid) ?? undefined;
    if (this.tracking) clearInterval(this.tracking);
    await this.trackDescendants();
    if (this.spec.profile.tool === 'codex' && this.turnId && !this.dead) {
      await Promise.race([this.rpc('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId }).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
    if (this.spec.profile.tool === 'copilot' && this.turnId && !this.dead) {
      await Promise.race([this.rpc('session.abort', { sessionId: this.sessionId }).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
    const identities = [this.identity, ...this.descendants.values()].filter((id): id is ProcessIdentity => !!id);
    const owned = await signalWorkerProcesses(identities, 'SIGTERM');
    this.hooks.owned(owned);
    await Promise.race([this.closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
    await signalWorkerProcesses(owned, 'SIGKILL');
    await Promise.race([this.closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
    await this.cleanup?.();
    const survivors = [];
    for (const id of owned) if (await identityMatches(id)) survivors.push(id);
    if (survivors.length) throw new Error('Owned processes remain alive; profile reservation retained');
  }
}
