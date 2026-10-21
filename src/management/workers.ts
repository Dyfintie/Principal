import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFile, realpath, stat, open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicWrite, sleep } from '../util.js';
import { managementPaths, privateDirectory } from './paths.js';
import { ManagementStore } from './store.js';
import type { Installation, Invocation, Profile } from './model.js';
import { identityMatches, processIdentity } from './process.js';
import { signalWorkerProcesses } from './worker-process.js';
import { removeIsolatedRuntime } from './antigravity-isolation.js';
import { authenticationConflicts, defaultDirectory } from './providers.js';
import { inspectWorkerCapabilities } from './worker-provider.js';
import { readWorkerRuntime, readWorkerEvents, workerCommand, runtimeFile } from './worker-files.js';
import { createWorkerWorkspace, releaseWorkerWorkspace, captureWorkerWorkspace } from './worker-workspace.js';
import { WorkerStart, WorkerControl, WorkerGet, WorkerMessage, WorkerArtifact, stamp, type WorkerCapabilities, type WorkerRecord, type WorkerRuntime, type WorkerSpec } from './worker-model.js';
import { SwarmDeploySchema } from './swarm-model.js';

interface Receipt { id: string; hash: string; method: string; result?: any; error?: string; workerId?: string; swarmId?: string }
interface SwarmRecord { id: string; startedAt: string; tasks: Array<{ id: string; profileId: string; workerId?: string; error?: string }> }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class WorkerManager {
  private readonly requests = new Map<string, Promise<any>>();
  private readonly capabilities = new Map<string, Promise<WorkerCapabilities>>();
  private reconciliation?: Promise<void>;
  constructor(readonly store: ManagementStore, private readonly installations: () => Installation[]) {}

  private inspect(installation: Installation) {
    const key = `${installation.tool}:${installation.executable}:${installation.version}:${installation.checkedAt}`;
    let result = this.capabilities.get(key);
    if (!result) { result = inspectWorkerCapabilities(installation); this.capabilities.set(key, result); }
    return result;
  }

  private record(id: string) { return this.store.require<WorkerRecord>('worker', id); }
  private lease(profileId: string) { return this.store.get<{ id: string; workerId: string }>('worker-lease', profileId); }
  private nativeProfileIds(profileId: string) {
    return this.store.get<Profile>('profile', profileId)?.tool === 'copilot'
      ? this.store.list<Profile>('profile').filter((p) => p.tool === 'copilot').map((p) => p.id) : [profileId];
  }
  private sharedLease(profileId: string) { return this.nativeProfileIds(profileId).map((id) => this.lease(id)).find(Boolean); }
  assertProfileFree(profileId: string) {
    const lease = this.sharedLease(profileId);
    if (lease) throw new Error(`Profile is reserved by worker ${lease.workerId}; stop that worker before launching or removing the profile`);
  }

  private async once(method: string, raw: { request_id: string }, action: (receipt: Receipt) => Promise<any>) {
    const id = digest(raw.request_id);
    const hash = digest({ method, raw });
    const previous = this.store.get<Receipt>('worker-request', id);
    if (previous) {
      if (previous.hash !== hash) throw new Error('request_id was already used with different arguments');
      const running = this.requests.get(id);
      if (running) return running;
      if ((method === 'message' || method === 'cancel') && 'worker_id' in raw && typeof raw.worker_id === 'string') {
        const runtime = await readWorkerRuntime(this.record(raw.worker_id));
        const delivered = runtime?.receipts[raw.request_id];
        if (delivered) return delivered.result;
      }
      if (previous.error) throw new Error(previous.error);
      if (previous.result !== undefined) return previous.result;
      if (previous.swarmId) return { swarmId: previous.swarmId, accepted: true, recoveryRequired: true };
      if (previous.workerId) return { workerId: previous.workerId, accepted: true, recoveryRequired: true };
      throw new Error('Previous delivery is uncertain; inspect the worker instead of automatically replaying this mutation');
    }
    const receipt: Receipt = { id, hash, method };
    this.store.put('worker-request', receipt);
    const pending = action(receipt).then((result) => {
      receipt.result = result; this.store.put('worker-request', receipt); return result;
    }, (error) => {
      receipt.error = (error as Error).message; this.store.put('worker-request', receipt); throw error;
    }).finally(() => this.requests.delete(id));
    this.requests.set(id, pending);
    return pending;
  }

  async profiles() {
    await this.reconcile();
    const installations = this.installations();
    return Promise.all(this.store.profiles().map(async (profile) => {
      const installation = installations.find((i) => i.tool === profile.tool);
      const quotas = this.quotaObservations(profile).map((row) => ({ bucket: row.bucket, metric: row.metric, account: row.account, remaining: Math.max(0, Math.min(100, row.metric === 'rate-limit-used' ? 100 - row.value : row.value)), observedAt: row.observedAt, source: row.source, sourceKind: row.sourceKind, resetsAt: row.resetsAt, stale: Date.now() - Date.parse(row.observedAt) > 300_000 }));
      const workers = this.store.list<WorkerRecord>('worker').filter((w) => w.profileId === profile.id);
      const recent = await Promise.all(workers.slice(-20).map(async (w) => ({ workerId: w.id, turn: (await readWorkerRuntime(w))?.turn })));
      const reservation = this.sharedLease(profile.id);
      let capabilities = installation ? await this.inspect(installation) : null;
      try { this.checkWorkerProfile(profile); }
      catch (error) {
        if (capabilities) capabilities = { ...capabilities, execution: false, resume: false, reason: (error as Error).message };
      }
      return {
        id: profile.id, label: profile.label, tool: profile.tool, auth: profile.auth,
        authObservedAt: profile.authObservedAt, account: profile.reportedAccount, isolated: profile.isolated,
        // Headroom is an observation summary, never a routing score or entitlement check.
        headroom: quotas.length ? Math.min(...quotas.map((q) => q.remaining)) : null,
        headroomStatus: !quotas.length ? 'unknown' : quotas.some((q) => q.stale) ? 'stale' : 'reported',
        quotas, busy: !!reservation || this.nativeBusy(profile.id), reservation: reservation?.workerId ?? null,
        capabilities,
        recentExecutions: recent.filter((r) => r.turn).map(({ workerId, turn }) => ({ workerId, status: turn!.status, startedAt: turn!.startedAt, endedAt: turn!.endedAt, error: turn!.error })),
      };
    }));
  }

  private nativeBusy(id: string) {
    const shared = new Set(this.nativeProfileIds(id));
    return this.store.list<Invocation>('invocation').some((i) => i.profileId !== null && shared.has(i.profileId) && i.lifecycle !== 'exited');
  }

  private checkWorkerProfile(profile: Profile) {
    if (profile.tool === 'copilot' && (profile.isolated || path.resolve(profile.directory) !== defaultDirectory('copilot')))
      throw new Error('Copilot workers require the current native configuration; independent account isolation is unsupported');
  }

  private quotaObservations(profile: Profile) {
    const observations = this.store.resources().filter((r) => r.profileId === profile.id && r.unit === 'percent' && ['quota-remaining', 'rate-limit-used'].includes(r.metric) && (!profile.reportedAccount || !r.account || profile.reportedAccount === r.account));
    const buckets = new Map<string, typeof observations[number]>();
    for (const row of observations) {
      const key = `${row.metric}:${row.bucket}`;
      if (!buckets.has(key) || buckets.get(key)!.observedAt < row.observedAt) buckets.set(key, row);
    }
    return [...buckets.values()];
  }

  async start(raw: unknown) {
    const options = WorkerStart.parse(raw);
    return this.once('start', options, async (receipt) => {
      await this.reconcile();
      const profile = this.store.require<Profile>('profile', options.profile_id);
      if (profile.removedAt) throw new Error('Profile has been removed');
      if (!['codex', 'antigravity', 'copilot'].includes(profile.tool)) throw new Error('Controlled execution is unsupported for this provider');
      if (profile.auth === 'unauthenticated') throw new Error('Profile authentication is rejected; use native sign-in before dispatching');
      if (authenticationConflicts(profile).length) throw new Error('Inherited provider authentication conflicts with the selected native profile; use a clean management environment');
      const installation = this.installations().find((i) => i.tool === profile.tool);
      if (!installation?.executable) throw new Error('Native provider executable is unavailable');
      const capabilities = await this.inspect(installation);
      if (!capabilities.execution) throw new Error(capabilities.reason);
      if (options.model && !capabilities.model) throw new Error('This native interface does not accept a model override');
      if (options.effort && !capabilities.effort.includes(options.effort)) throw new Error(`Unsupported reasoning effort for this native interface: ${options.effort}`);
      this.checkWorkerProfile(profile);
      this.checkConstraints(profile);
      const cwd = await realpath(options.cwd);
      if (!(await stat(cwd)).isDirectory()) throw new Error('Choose a repository directory');
      const id = randomUUID();
      const directory = path.join(managementPaths.state, 'workers', id);
      const record: WorkerRecord = { id, generation: randomUUID(), profileId: profile.id, profileLabel: profile.label, tool: profile.tool as WorkerRecord['tool'], directory, socket: path.join(managementPaths.runtime, `w-${id}.sock`), createdAt: stamp(), requestedModel: options.model, requestedEffort: options.effort, timeoutSeconds: options.timeout_seconds };
      if (Buffer.byteLength(record.socket) > 103) throw new Error('Worker socket path is too long; choose a shorter XDG_RUNTIME_DIR');
      // No await between checking and inserting the exclusive lease.
      this.store.db.transaction(() => {
        this.assertProfileFree(profile.id);
        if (this.nativeBusy(profile.id)) throw new Error('Profile has an active or uncertain native invocation');
        this.store.put('worker-lease', { id: profile.id, workerId: id });
        this.store.put('worker', record);
        receipt.workerId = id; this.store.put('worker-request', receipt);
      })();
      try {
        await privateDirectory(path.dirname(directory)); await privateDirectory(directory);
        record.workspace = await createWorkerWorkspace(cwd, id, (workspace) => { record.workspace = workspace; this.store.put('worker', record); });
        this.store.put('worker', record);
        const spec: WorkerSpec = { record, options: { ...options, cwd }, profile, installation, capabilities, resume: false };
        await this.spawn(spec);
        return { workerId: id, accepted: true, workspace: record.workspace, requestedModel: options.model ?? null, requestedEffort: options.effort ?? null };
      } catch (error) {
        record.startupError = 'Worker setup failed; inspect retained state and workspace';
        this.store.put('worker', record);
        if (!record.runner) this.releaseLease(record);
        throw error;
      }
    });
  }

  private checkConstraints(profile: Profile) {
    const constraints = profile.handoffConstraints;
    if (!constraints) return;
    if (constraints.expiresAt && Date.now() >= Date.parse(constraints.expiresAt)) throw new Error('Profile handoff has expired');
    if (constraints.allowedQuotaFloor !== undefined) {
      const observations = this.quotaObservations(profile);
      if (observations.some((r) => (r.metric === 'rate-limit-used' ? 100 - r.value : r.metric === 'quota-remaining' ? r.value : Infinity) <= constraints.allowedQuotaFloor!)) throw new Error('Profile handoff quota budget is exhausted');
    }
  }

  private async spawn(spec: WorkerSpec) {
    const file = path.join(spec.record.directory, 'spec.json');
    await atomicWrite(file, JSON.stringify(spec));
    const log = await open(path.join(spec.record.directory, 'runner.log'), 'a', 0o600);
    try {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./worker-runner.js', import.meta.url)), file], { detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      spec.record.runner = await processIdentity(child.pid!) ?? undefined;
      this.store.put('worker', spec.record); child.unref();
    } finally { await log.close(); }
  }

  private releaseLease(record: WorkerRecord) {
    this.store.db.prepare("DELETE FROM records WHERE kind='worker-lease' AND id=? AND json_extract(data,'$.workerId')=?").run(record.profileId, record.id);
  }

  async reconcile() {
    if (this.reconciliation) return this.reconciliation;
    this.reconciliation = this.reconcileAll().finally(() => { this.reconciliation = undefined; });
    return this.reconciliation;
  }

  private async reconcileAll() {
    for (const record of this.store.list<WorkerRecord>('worker')) {
      if (record.releasedAt || this.lease(record.profileId)?.workerId !== record.id) continue;
      const runtime = await readWorkerRuntime(record);
      // A resumed runner must never be mistaken for the preceding stopped one.
      if (!runtime || runtime.generation !== record.generation) continue;
      const runner = record.runner && await identityMatches(record.runner) ? record.runner : runtime.runner;
      const alive = runner && await identityMatches(runner);
      if (alive) {
        const profile = this.store.get<Profile>('profile', record.profileId);
        if (profile?.handoffConstraints) {
          try { this.checkConstraints(profile); }
          catch { await workerCommand(record, 'cancel', { worker_id: record.id, request_id: `handoff-stop-${record.id}` }).catch(() => {}); }
        }
        continue;
      }
      let release = false;
      const known = [...(runtime.ownedProcesses ?? []), ...(runtime.native ? [runtime.native] : [])];
      const live = await Promise.all(known.map(identityMatches));
      if (live.some(Boolean)) {
        runtime.lifecycle = 'interrupted'; runtime.cleanupRequired = true;
        runtime.error = { category: 'ownership', message: 'Runner exited while an owned native process remains; explicit cancellation is required' };
      } else if (runtime.nativeLaunchPending) {
        runtime.lifecycle = 'interrupted'; runtime.cleanupRequired = true;
        runtime.error = { category: 'ownership', message: 'Runner was lost during native launch; ownership is uncertain and the reservation is retained' };
      } else if (!runtime.cleanupRequired) {
        if (runtime.lifecycle !== 'stopped') {
          runtime.lifecycle = 'interrupted';
          if (runtime.turn?.status === 'running') { runtime.turn.status = 'interrupted'; runtime.turn.endedAt = stamp(); }
        }
        release = true;
      }
      if (runtime.firstTurn?.id === runtime.turn?.id) runtime.firstTurn = runtime.turn;
      await atomicWrite(runtimeFile(record), JSON.stringify(runtime));
      if (release) this.releaseLease(record);
    }
  }

  async list() {
    await this.reconcile();
    return Promise.all(this.store.list<WorkerRecord>('worker').map((record) => this.summary(record)));
  }

  private async summary(record: WorkerRecord) {
    const runtime = await readWorkerRuntime(record);
    const { pending: _pending, receipts: _receipts, ...safe } = runtime ?? {} as Partial<WorkerRuntime>;
    return { workerId: record.id, profileId: record.profileId, profileLabel: record.profileLabel, tool: record.tool, createdAt: record.createdAt, workspace: record.workspace, releasedAt: record.releasedAt, startupError: record.startupError, requestedModel: record.requestedModel ?? null, requestedEffort: record.requestedEffort ?? null, timeoutSeconds: record.timeoutSeconds,
      ...safe, lifecycle: record.releasedAt ? 'released' : runtime && runtime.generation !== record.generation ? 'starting' : runtime?.lifecycle ?? (record.stoppedAt ? 'stopped' : record.startupError ? 'interrupted' : 'starting'),
      queuedMessages: runtime?.pending.length ?? 0, reserved: this.lease(record.profileId)?.workerId === record.id,
      inactivityWarning: runtime?.lifecycle === 'running' && Date.now() - Date.parse(runtime.lastProgressAt) > 120_000,
      heartbeatStale: !!runtime && Date.now() - Date.parse(runtime.heartbeatAt) > 15_000,
    };
  }

  async get(raw: unknown, signal?: AbortSignal) {
    const input = WorkerGet.parse(raw);
    const end = Date.now() + input.wait_seconds * 1000;
    const record = this.record(input.worker_id);
    do {
      if (signal?.aborted) throw new Error('Worker polling request cancelled; execution continues');
      await this.reconcile();
      const update = await readWorkerEvents(record, input.cursor);
      const summary = await this.summary(record);
      if (update.events.length || Date.now() >= end || ['stopped', 'interrupted', 'released'].includes(summary.lifecycle)) return { ...summary, ...update };
      await sleep(Math.min(100, Math.max(1, end - Date.now())));
    } while (true);
  }

  async message(raw: unknown) {
    const input = WorkerMessage.parse(raw);
    return this.once('message', input, async () => workerCommand(this.record(input.worker_id), 'message', input, 34_000));
  }

  async cancel(raw: unknown) {
    const input = WorkerControl.parse(raw);
    return this.once('cancel', input, async () => {
      await this.reconcile();
      const record = this.record(input.worker_id);
      if (record.releasedAt) return { workerId: record.id, lifecycle: 'released' };
      const state = await readWorkerRuntime(record);
      if (state && ['stopped', 'interrupted'].includes(state.lifecycle) && !this.lease(record.profileId)) return { workerId: record.id, lifecycle: state.lifecycle };
      const runner = record.runner && await identityMatches(record.runner) ? record.runner : state?.runner;
      if (runner && await identityMatches(runner)) return workerCommand(record, 'cancel', input);
      if (state && state.generation !== record.generation) throw new Error('Worker launch is in flight or its ownership is uncertain; the profile reservation is retained');
      if (state?.nativeLaunchPending && !state.native) throw new Error('Native launch ownership is uncertain; inspect native processes before recovery. The profile remains reserved');
      // Explicit recovery after runner loss. Never signal an unchecked bare PID.
      const known = [...(state?.ownedProcesses ?? []), ...(state?.native ? [state.native] : [])];
      const signalled = await signalWorkerProcesses(known, 'SIGTERM');
      await sleep(signalled.length ? 2000 : 0);
      await signalWorkerProcesses(signalled, 'SIGKILL');
      for (const identity of signalled) if (await identityMatches(identity)) throw new Error('Owned processes are still exiting; retry cancellation with a new request_id after inspection');
      if (state?.isolatedRuntimeDir) await removeIsolatedRuntime(state.isolatedRuntimeDir);
      if (state) {
        state.lifecycle = 'stopped'; state.cleanupRequired = false;
        if (state.turn?.status === 'running') { state.turn.status = 'cancelled'; state.turn.endedAt = stamp(); }
        if (state.firstTurn?.id === state.turn?.id) state.firstTurn = state.turn;
        if (state.turn && record.workspace && !state.turn.artifacts) {
          try {
            const snapshot = await captureWorkerWorkspace(record.workspace);
            const name = `turn-${state.turn.number}`;
            await privateDirectory(path.join(record.directory, 'artifacts'));
            await atomicWrite(path.join(record.directory, 'artifacts', `${name}.patch`), snapshot.diff);
            await atomicWrite(path.join(record.directory, 'artifacts', `${name}.json`), JSON.stringify({ baseRevision: record.workspace.baseRevision, modifiedFiles: snapshot.files, turn: state.turn }));
            state.turn.artifacts = [`${name}.patch`, `${name}.json`];
          } catch { state.turn.captureError = 'Recovery patch capture failed; worktree retained'; }
        }
        await atomicWrite(runtimeFile(record), JSON.stringify(state));
      }
      record.stoppedAt = stamp(); this.store.put('worker', record);
      this.releaseLease(record);
      return { workerId: record.id, lifecycle: 'stopped', recovered: true };
    });
  }

  async resume(raw: unknown) {
    const input = WorkerControl.parse(raw);
    return this.once('resume', input, async (receipt) => {
      await this.reconcile();
      const record = this.record(input.worker_id);
      if (record.releasedAt || !record.workspace) throw new Error('Released or unprovisioned workers cannot be resumed');
      const runtime = await readWorkerRuntime(record);
      if (!runtime?.nativeSessionId || runtime.cleanupRequired) throw new Error('Native session is unavailable or cleanup is unresolved');
      if (!['stopped', 'interrupted'].includes(runtime.lifecycle)) throw new Error('Stop the current worker before resuming');
      if (runtime.runner && await identityMatches(runtime.runner)) throw new Error('Previous runner has not exited yet');
      const spec: WorkerSpec = JSON.parse(await readFile(path.join(record.directory, 'spec.json'), 'utf8'));
      const profile = this.store.require<Profile>('profile', record.profileId);
      if (profile.removedAt || profile.auth === 'unauthenticated') throw new Error('Original profile is unavailable or authentication is rejected');
      if (authenticationConflicts(profile).length) throw new Error('Inherited provider authentication conflicts with the original native profile');
      this.checkWorkerProfile(profile);
      this.checkConstraints(profile);
      const installation = this.installations().find((i) => i.tool === profile.tool);
      if (!installation) throw new Error('Original provider is unavailable');
      const capabilities = await this.inspect(installation);
      if (!capabilities.execution || !capabilities.resume) throw new Error('Native resume is unsupported');
      this.store.db.transaction(() => {
        this.assertProfileFree(record.profileId);
        if (this.nativeBusy(record.profileId)) throw new Error('Profile has an active native invocation');
        this.store.put('worker-lease', { id: record.profileId, workerId: record.id });
        record.generation = randomUUID();
        delete record.runner;
        this.store.put('worker', record);
        receipt.workerId = record.id; this.store.put('worker-request', receipt);
      })();
      await this.spawn({ ...spec, record, profile, installation, capabilities, resume: true });
      return { workerId: record.id, accepted: true, resumed: true };
    });
  }

  async artifact(raw: unknown) {
    const input = WorkerArtifact.parse(raw);
    const record = this.record(input.worker_id);
    const file = path.join(record.directory, 'artifacts', input.artifact_id);
    const handle = await open(file, 'r');
    try {
      const size = (await handle.stat()).size;
      if (input.offset > size) throw new Error('Artifact offset exceeds its size');
      const buffer = Buffer.alloc(input.length);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, input.offset);
      // Base64 preserves UTF-8 boundaries and binary patch bytes across chunks.
      return { artifactId: input.artifact_id, encoding: 'base64', data: buffer.subarray(0, bytesRead).toString('base64'), size, nextOffset: input.offset + bytesRead, eof: input.offset + bytesRead >= size };
    } finally { await handle.close(); }
  }

  async release(raw: unknown) {
    const input = WorkerControl.parse(raw);
    return this.once('release', input, async () => {
      await this.reconcile();
      const record = this.record(input.worker_id);
      if (record.releasedAt) return { workerId: record.id, released: true };
      const runtime = await readWorkerRuntime(record);
      if (this.lease(record.profileId)?.workerId === record.id || runtime?.cleanupRequired) throw new Error('Stop the worker and resolve ownership before releasing its workspace');
      if (record.workspace) {
        const snapshot = await captureWorkerWorkspace(record.workspace);
        const name = 'final';
        const artifacts = path.join(record.directory, 'artifacts');
        await privateDirectory(artifacts);
        await atomicWrite(path.join(artifacts, `${name}.patch`), snapshot.diff);
        await atomicWrite(path.join(artifacts, `${name}.json`), JSON.stringify({ baseRevision: record.workspace.baseRevision, modifiedFiles: snapshot.files, turn: runtime?.turn }));
        await releaseWorkerWorkspace(record.workspace);
      }
      record.releasedAt = stamp(); this.store.put('worker', record);
      return { workerId: record.id, released: true, artifactsRetained: true };
    });
  }

  async deploy(raw: unknown) {
    const input = SwarmDeploySchema.parse(raw);
    const tasks = input.tasks.map((task, index) => ({ ...task, id: task.id ?? `task-${digest([input.request_id, index]).slice(0, 16)}` }));
    return this.once('swarm.deploy', input, async (receipt) => {
      await this.reconcile();
      for (const task of tasks) {
        const profile = this.store.require<Profile>('profile', task.profile_id);
        if (input.provider && input.provider !== profile.tool) throw new Error('Explicit profile does not match the requested provider');
        if (!['codex', 'antigravity', 'copilot'].includes(profile.tool)) throw new Error('Unsupported worker provider');
        this.checkWorkerProfile(profile);
        this.assertProfileFree(profile.id);
        if (this.nativeBusy(profile.id)) throw new Error(`Profile ${profile.id} is busy`);
      }
      const swarm: SwarmRecord = { id: randomUUID(), startedAt: stamp(), tasks: tasks.map((t) => ({ id: t.id, profileId: t.profile_id })) };
      receipt.swarmId = swarm.id;
      this.store.db.transaction(() => { this.store.put('swarm', swarm); this.store.put('worker-request', receipt); })();
      for (const [index, task] of tasks.entries()) {
        try {
          const { id: taskId, ...options } = task;
          const result = await this.start({ ...options, timeout_seconds: input.timeout_seconds, request_id: digest([input.request_id, taskId]) });
          swarm.tasks[index].workerId = result.workerId;
        } catch (error) { swarm.tasks[index].error = (error as Error).message; }
        this.store.put('swarm', swarm);
      }
      return this.swarmStatus(swarm.id);
    });
  }

  async swarmStatus(id: string) {
    await this.reconcile();
    const swarm = this.store.get<SwarmRecord>('swarm', id);
    if (!swarm) return null;
    const workers = await Promise.all(swarm.tasks.map(async (task) => {
      if (!task.workerId) return { id: task.id, profileId: task.profileId, status: 'failed', error: task.error ?? 'Dispatch was interrupted before worker creation' };
      const summary = await this.summary(this.record(task.workerId));
      return { ...summary, id: task.id, status: summary.firstTurn?.status ?? (['stopped', 'interrupted'].includes(summary.lifecycle) ? 'interrupted' : 'running'), artifacts: summary.firstTurn?.artifacts ?? [] };
    }));
    const statuses = workers.map((w) => w.status);
    const completed = statuses.filter((s) => s === 'completed').length;
    const status = statuses.includes('running') ? 'running' : completed === workers.length ? 'completed' : completed > 0 ? 'partial' : statuses.every((s) => s === 'cancelled') ? 'cancelled' : 'failed';
    return { swarmId: swarm.id, startedAt: swarm.startedAt, status, workers, summary: `${completed}/${workers.length} initial worker turns completed; artifacts require lead review` };
  }

  async cancelBatch(raw: unknown) {
    const input = z.object({ swarm_id: z.string().uuid(), request_id: z.string().min(1).max(160) }).strict().parse(raw);
    return this.once('swarm.cancel', input, async () => {
      const swarm = this.store.require<SwarmRecord>('swarm', input.swarm_id);
      const tasks = swarm.tasks.filter((t) => t.workerId);
      const results = await Promise.allSettled(tasks.map((task) => this.cancel({ worker_id: task.workerId, request_id: digest([input.request_id, task.id]) })));
      return { swarmId: swarm.id, cancellationRequested: true, workers: results.map((result, index) => result.status === 'fulfilled' ? result.value : { error: result.reason.message, workerId: tasks[index].workerId }) };
    });
  }

  async rpc(method: string, raw: unknown, signal?: AbortSignal): Promise<unknown> {
    switch (method) {
      case 'workers.swarm.deploy': return this.deploy(raw);
      case 'workers.swarm.status': return this.swarmStatus(z.object({ swarm_id: z.string().uuid() }).strict().parse(raw).swarm_id);
      case 'workers.swarm.cancel': return this.cancelBatch(raw);
      case 'workers.profiles': return this.profiles();
      case 'workers.start': return this.start(raw);
      case 'workers.list': return this.list();
      case 'workers.get': return this.get(raw, signal);
      case 'workers.message': return this.message(raw);
      case 'workers.cancel': return this.cancel(raw);
      case 'workers.resume': return this.resume(raw);
      case 'workers.artifact': return this.artifact(raw);
      case 'workers.release': return this.release(raw);
      default: throw new Error('Unknown worker method');
    }
  }
}
