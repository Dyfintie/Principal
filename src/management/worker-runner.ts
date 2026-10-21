import { createServer } from 'node:net';
import { readFile, mkdir, chmod, rm } from 'node:fs/promises';
import { appendFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { atomicWrite, redact } from '../util.js';
import { processIdentity } from './process.js';
import { WorkerMessage, WorkerControl, stamp, type WorkerRuntime, type WorkerSpec, type WorkerTurn } from './worker-model.js';
import { runtimeFile, readWorkerRuntime } from './worker-files.js';
import { captureWorkerWorkspace } from './worker-workspace.js';
import { WorkerProvider, providerFailure } from './worker-provider.js';

export async function runWorker(specFile: string) {
  process.umask(0o077);
  const spec: WorkerSpec = JSON.parse(await readFile(specFile, 'utf8'));
  const record = spec.record;
  const identity = await processIdentity(process.pid);
  if (!identity) throw new Error('Worker runner identity is unavailable');
  const previous = spec.resume ? await readWorkerRuntime(record) : null;
  const state: WorkerRuntime = {
    generation: record.generation,
    lifecycle: 'starting', runner: identity, heartbeatAt: stamp(), lastProgressAt: stamp(),
    seq: previous?.seq ?? 0, turnCount: previous?.turnCount ?? 0,
    pending: previous?.pending ?? [], receipts: previous?.receipts ?? {},
    paused: spec.resume,
    ...(previous?.firstTurn ? { firstTurn: previous.firstTurn } : {}),
    ...(previous?.nativeSessionId ? { nativeSessionId: previous.nativeSessionId } : {}),
    ...(previous?.turn ? { turn: previous.turn } : {}),
  };
  const journal = path.join(record.directory, 'events.jsonl');
  if (state.firstTurn?.id === state.turn?.id) state.firstTurn = state.turn;
  const save = () => {
    const file = runtimeFile(record);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    const fd = openSync(temporary, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    const parent = openSync(record.directory, 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  };
  const event = (type: string, data: Record<string, unknown> = {}, progress = false) => {
    if (progress) state.lastProgressAt = stamp();
    const row = { seq: ++state.seq, at: stamp(), type, ...data };
    appendFileSync(journal, JSON.stringify(row) + '\n', { mode: 0o600 });
    const fd = openSync(journal, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    save();
  };
  save();
  await mkdir(path.join(record.directory, 'artifacts'), { recursive: true, mode: 0o700 });
  let stopping: Promise<void> | undefined;
  let finishing: Promise<void> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let startup: ReturnType<typeof setTimeout> | undefined;
  let initialized = false;
  let finalizing = false;
  let commandQueue = Promise.resolve();

  async function capture(turn: WorkerTurn) {
    const { diff, files } = await captureWorkerWorkspace(record.workspace!);
    const name = `turn-${turn.number}`;
    await atomicWrite(path.join(record.directory, 'artifacts', `${name}.patch`), diff);
    await atomicWrite(path.join(record.directory, 'artifacts', `${name}.json`), JSON.stringify({ baseRevision: record.workspace!.baseRevision, modifiedFiles: files, turn }, null, 2));
    turn.artifacts = [`${name}.patch`, `${name}.json`];
    delete turn.captureError;
  }

  async function finish(status: WorkerTurn['status'], error?: WorkerTurn['error']) {
    if (!state.turn || state.turn.status !== 'running') return;
    const turn = state.turn;
    finalizing = true;
    clearTimeout(deadline);
    turn.status = status; turn.endedAt = stamp(); turn.error = error;
    // Persist the terminal outcome before any asynchronous artifact work.
    event('turn.finished', { turnId: turn.id, status, ...(error ? { error } : {}) }, true);
    if (status !== 'completed') {
      finalizing = false;
      if (!stopping) void stop(status);
      return;
    }
    try { await capture(turn); event('artifacts.saved', { turnId: turn.id, artifacts: turn.artifacts }); }
    catch { turn.captureError = 'Patch capture failed; worktree retained and release blocked'; event('artifacts.failed', { turnId: turn.id, message: turn.captureError }); }
    finalizing = false;
    if (!stopping) state.lifecycle = 'ready';
    save();
    if (!stopping && !turn.captureError) void drain();
  }

  const provider = new WorkerProvider(spec, {
    activity: (kind, data = {}) => event(`provider.${kind}`, data, kind !== 'diagnostic'),
    session: (id, model) => { state.nativeSessionId = id; if (model) state.reportedModel = model; event('provider.session', { nativeSessionId: id, ...(model ? { model } : {}) }, true); },
    turnId: (id) => { if (state.turn?.status === 'running') { state.turn.providerTurnId = id; event('turn.native', { turnId: state.turn.id, providerTurnId: id }, true); } },
    result: (status, error) => { finishing = finish(status, error).catch(() => { state.error = { category: 'artifact', message: 'Turn finalization failed; inspect retained workspace' }; save(); }); },
    exited: (code) => {
      if (state.turn) state.turn.exitCode = code;
      if (!stopping) { state.error = { category: 'process', message: 'Provider exited unexpectedly' }; void stop('interrupted'); }
      save();
    },
    identity: (native) => { state.native = native; state.nativeLaunchPending = false; save(); },
    owned: (identities) => { state.ownedProcesses = identities; save(); },
    isolation: (directory) => { state.isolatedRuntimeDir = directory; save(); },
    launching: () => { state.nativeLaunchPending = true; save(); },
  });

  async function drain() {
    if (!initialized || stopping || finalizing || state.paused || state.lifecycle !== 'ready' || !state.pending.length || state.turn?.captureError) return;
    const next = state.pending.shift()!;
    const turn: WorkerTurn = { id: randomUUID(), number: ++state.turnCount, requestId: next.requestId, status: 'running', startedAt: stamp() };
    state.turn = turn; state.lifecycle = 'running';
    if (turn.number === 1) state.firstTurn = turn;
    event('turn.started', { turnId: turn.id, requestId: next.requestId }, true);
    deadline = setTimeout(() => { void stop('timeout'); }, spec.options.timeout_seconds * 1000);
    try { await provider.turn(next.message, next.requestId); }
    catch (error) { finishing = finish('failed', providerFailure(String(error))); await finishing; }
  }

  async function stop(reason: WorkerTurn['status'] = 'cancelled') {
    if (stopping) return stopping;
    // Install the latch before provider interruption can emit a result callback.
    stopping = Promise.resolve().then(async () => {
      clearTimeout(deadline); clearTimeout(startup);
      state.lifecycle = 'stopping'; event('worker.stopping', { reason });
      state.paused = true;
      if (state.turn?.status === 'running') {
        state.turn.status = reason;
        state.turn.endedAt = stamp();
        event('turn.finished', { turnId: state.turn.id, status: reason });
      }
      try { await provider.stop(); state.nativeLaunchPending = false; }
      catch { state.cleanupRequired = true; state.error = { category: 'cleanup', message: 'Provider cleanup incomplete; profile reservation retained' }; }
      await finishing;
      if (state.turn && !state.turn.artifacts) {
        try { await capture(state.turn); }
        catch { state.turn.captureError = 'Patch capture failed; release blocked'; }
      }
      state.lifecycle = state.cleanupRequired ? 'interrupted' : 'stopped';
      event('worker.stopped', { cleanupRequired: state.cleanupRequired ?? false });
      clearInterval(heartbeat);
      server.close();
      await rm(record.socket, { force: true });
    });
    return stopping;
  }

  const server = createServer((socket) => {
    socket.setTimeout(35_000, () => socket.destroy());
    socket.on('error', () => {});
    let body = '', handled = false;
    socket.on('data', (chunk) => {
      if (handled) return;
      body += chunk.toString();
      if (Buffer.byteLength(body) > 96 * 1024) { socket.destroy(); return; }
      if (!body.includes('\n')) return;
      handled = true;
      const handle = async () => {
        try {
          const command = JSON.parse(body.slice(0, body.indexOf('\n')));
          if (!['message', 'cancel'].includes(command.method)) throw new Error('Unknown worker operation');
          const input = command.method === 'message' ? WorkerMessage.parse(command.params) : WorkerControl.parse(command.params);
          if (input.worker_id !== record.id) throw new Error('Worker ID mismatch');
          const hash = createHash('sha256').update(JSON.stringify({ method: command.method, input })).digest('hex');
          const previous = state.receipts[input.request_id];
          if (previous) {
            if (previous.hash !== hash) throw new Error('request_id was already used with different arguments');
            socket.end(JSON.stringify({ result: previous.result }) + '\n'); return;
          }
          let result: Record<string, unknown>;
          if (command.method === 'cancel') {
            result = { workerId: record.id, accepted: true, lifecycle: 'stopping' };
            state.receipts[input.request_id] = { hash, result }; save();
            socket.end(JSON.stringify({ result }) + '\n'); void stop(); return;
          }
          const message = WorkerMessage.parse(input);
          if (!initialized || stopping || !['running', 'ready'].includes(state.lifecycle)) throw new Error('Worker is not accepting messages; inspect or explicitly resume it');
          const activeTurn = state.lifecycle === 'running' && state.turn?.status === 'running' && !finalizing;
          const steer = activeTurn && (message.delivery === 'steer' || message.delivery === 'auto' && spec.capabilities.steer);
          if (message.delivery === 'steer' && (!spec.capabilities.steer || !activeTurn)) throw new Error('Live steering is unavailable; use next_turn or inspect the active turn');
          if (steer) {
            const expected = message.expected_turn_id;
            if (!expected || expected !== state.turn?.providerTurnId) throw new Error('Steering requires the current expected_turn_id from principal_get_worker');
            // Record acceptance before transport I/O; never replay ambiguous delivery.
            result = { workerId: record.id, delivery: 'steer', accepted: true, turnId: state.turn!.id };
            state.receipts[input.request_id] = { hash, result: { ...result, delivery: 'uncertain' } }; save();
            await provider.steer(message.message, expected, message.request_id);
          } else {
            state.pending.push({ requestId: message.request_id, message: message.message });
            state.paused = false;
            result = { workerId: record.id, delivery: 'next_turn', accepted: true };
          }
          state.receipts[input.request_id] = { hash, result };
          event('message.accepted', { requestId: input.request_id, delivery: result.delivery });
          socket.end(JSON.stringify({ result }) + '\n'); void drain();
        } catch (error) { socket.end(JSON.stringify({ error: redact((error as Error).message) }) + '\n'); }
      };
      try {
        if (JSON.parse(body.slice(0, body.indexOf('\n'))).method === 'cancel') void handle().catch(() => { socket.destroy(); });
        else commandQueue = commandQueue.then(handle).catch(() => { socket.destroy(); });
      } catch { socket.end(JSON.stringify({ error: 'Invalid worker control JSON' }) + '\n'); }
    });
  });
  await rm(record.socket, { force: true });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(record.socket, resolve); });
  await chmod(record.socket, 0o600);
  const heartbeat = setInterval(() => { state.heartbeatAt = stamp(); save(); }, 4000);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => { void stop('interrupted'); });
  startup = setTimeout(() => { state.error = { category: 'startup', message: 'Provider startup exceeded 60 seconds' }; void stop('timeout'); }, 60_000);
  try {
    event('worker.starting', { resumed: spec.resume });
    await provider.start(state.nativeSessionId);
    if (!stopping) {
      clearTimeout(startup); initialized = true; state.lifecycle = 'ready';
      if (!spec.resume) state.pending.push({ requestId: spec.options.request_id, message: spec.options.task });
      event('worker.ready');
      void drain();
    }
  } catch (error) {
    state.error = providerFailure(String(error)); event('worker.startup_failed', { error: state.error });
    await stop('failed');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runWorker(process.argv[2]).catch(() => { process.stderr.write('Principal worker runner failed; retained state requires inspection.\n'); process.exitCode = 1; });
}
