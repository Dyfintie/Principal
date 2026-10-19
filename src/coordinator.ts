import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { totalmem, availableParallelism } from 'node:os';
import { z } from 'zod';
import { SupervisorBridge } from './supervisor.js';
import { Locks } from './locks.js';
import { Sessions } from './sessions.js';
import { NativeSessions } from './native.js';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { Repository, cleanRepository, git } from './repository.js';
import {
  ConfigSchema,
  Provider,
  validateGraph,
  resultSchema,
  ResultSchema,
  graphOutputSchema,
  supervisorReviewSchema,
  type Account,
  type QuotaSnapshot,
  type Config,
  type Run,
  type TaskRecord,
  type Attempt,
  type Graph,
} from './schema.js';
import { adapter } from './providers/index.js';
import { codexQuota, classifyProviderFailure } from './providers/quota.js';
import { selectAccount } from './scheduler.js';
import { uid, now, paths, redact, sleep } from './util.js';
const labelSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
class AccountBusyError extends Error {}
export class Coordinator {
  locks = new Locks();
  store = new Store();
  runtime = new Runtime((account, generation) =>
    this.store.saveAccount({ ...account, generation }),
  );
  repo = new Repository();
  sessions = new Sessions(this);
  native = new NativeSessions(this);
  ticking = false;
  finishing = new Set<string>();
  integrationJobs = new Set<string>();
  planningJobs = new Set<string>();
  excluded = new Map<string, Set<string>>();
  probeAt = new Map<string, number>();
  probeJobs = new Map<string, Promise<unknown>>();
  probeErrors = new Map<string, number>();
  async safeStopAndRelease(accountId: string, owner: string, container?: string | null) {
    // A partially created runtime may have been recorded on the lease before create() rejected.
    container ??= this.store
      .leases()
      .find((l) => l.accountId === accountId && l.owner === owner)?.container;
    if (container) {
      try {
        await this.runtime.stop(container);
      } catch (error) {
        if (await this.runtime.exists(container)) throw error;
      }
      if (await this.runtime.exists(container))
        throw new Error('Account runtime did not stop; lease retained');
    }
    this.store.release(accountId, owner);
  }
  blockQuota(account: Account, model: string | null | undefined, error: string) {
    const q = this.store.quota(account.id) ?? {
      accountId: account.id,
      observedAt: now(),
      source: account.provider,
      state: 'unknown' as const,
      buckets: [],
    };
    q.blockedModels = [...new Set([...(q.blockedModels ?? []), model ?? account.model ?? '*'])];
    q.error = error;
    this.store.saveQuota(q);
  }
  async startup() {
    await this.sessions.startup();
    for (const run of this.store.runs().filter((r) => r.status === 'planning')) {
      run.status = 'needs_review';
      run.error = 'Planning was interrupted; resume explicitly to continue';
      this.store.saveRun(run);
    }
    for (const a of this.store
      .attempts()
      .filter((a) => ['starting', 'running'].includes(a.status))) {
      let exists: boolean;
      try {
        exists = await this.runtime.exists(a.container);
      } catch (e) {
        const r = this.store.run(a.runId);
        r.status = 'needs_review';
        r.error = 'Docker state is unavailable; execution and account lease retained for review';
        this.store.saveRun(r);
        continue;
      }
      if (exists) {
        a.status = 'running';
        this.store.saveAttempt(a);
      } else {
        await this.runtime.stop(a.container);
        a.status = 'needs_review';
        this.store.saveAttempt(a);
        const r = this.store.run(a.runId);
        r.status = 'needs_review';
        r.error = 'Worker disappeared; review its last checkpoint before resuming';
        this.store.saveRun(r);
        const t = this.store.tasks(r.id).find((t) => t.id === a.taskId);
        if (t) {
          t.status = 'needs_review';
          this.store.saveTask(t);
        }
        this.store.release(a.accountId, a.id);
      }
    }
    // A stale actor lease is only released after the old container is confirmed stopped.
    const attempts = new Set(
      this.store
        .attempts()
        .filter((a) => ['starting', 'running'].includes(a.status))
        .map((a) => a.id),
    );
    for (const lease of this.store.leases()) {
      if (attempts.has(lease.owner) || this.native.list().some((session) => session.owner === lease.owner)) continue;
      if (lease.container) {
        try {
          await this.runtime.snapshot(this.store.account(lease.accountId), lease.container);
        } catch {}
        await this.runtime.stop(lease.container).catch(() => {});
      }
      try {
        if (!lease.container || !(await this.runtime.exists(lease.container)))
          this.store.release(lease.accountId, lease.owner);
      } catch {
        /* Unknown Docker state preserves the lease; history remains accessible. */
      }
    }
  }
  async isolated<T>(
    a: Account,
    config: Config,
    owner: string,
    fn: (container: string) => Promise<T>,
  ) {
    if (!this.store.lease(a.id, owner)) throw new AccountBusyError(`Account ${a.label} is busy`);
    let container: string | undefined;
    try {
      container = `principal-${uid()}`;
      this.store.setContainer(a.id, container);
      await this.runtime.create(a, config, { name: container });
      const result = await fn(container);
      await this.runtime.snapshot(a, container);
      return result;
    } finally {
      await this.safeStopAndRelease(a.id, owner, container);
    }
  }
  async refresh(a: Account, config: Config) {
    try {
      return await this.isolated(a, config, `probe-${uid()}`, async (c) => {
        const q = await adapter(a, this.runtime).readQuota(a, c);
        this.store.saveQuota(q);
        this.probeErrors.delete(a.id);
        return q;
      });
    } catch (e) {
      if (e instanceof AccountBusyError) return this.store.quota(a.id);
      this.probeErrors.set(a.id, (this.probeErrors.get(a.id) ?? 0) + 1);
      const previous = this.store.quota(a.id);
      const q: QuotaSnapshot = {
        accountId: a.id,
        observedAt: previous?.observedAt ?? now(),
        source: previous?.source ?? a.provider,
        state: previous ? ('stale' as const) : ('unknown' as const),
        buckets: previous?.buckets ?? [],
        blockedModels: previous?.blockedModels,
        error: redact((e as Error).message),
      };
      if (classifyProviderFailure((e as any).providerError) === 'auth') {
        a.status = 'auth_required';
        this.store.saveAccount(a);
        q.state = 'auth_required';
      }
      this.store.saveQuota(q);
      return q;
    }
  }
  scheduleProbe(a: Account, config: Config) {
    if (this.store.leases().some((lease) => lease.accountId === a.id)) return;
    if (this.probeJobs.has(a.id) || this.probeJobs.size >= 2) return;
    const backoff = 300000 * Math.min(6, 2 ** (this.probeErrors.get(a.id) ?? 0));
    if (Date.now() - (this.probeAt.get(a.id) ?? 0) < backoff) return;
    this.probeAt.set(a.id, Date.now());
    const job = this.refresh(a, config);
    this.probeJobs.set(a.id, job);
    void job.finally(() => this.probeJobs.delete(a.id));
  }
  async beginLogin(args: any) {
    const provider = Provider.parse(args.provider),
      label = labelSchema.parse(args.label);
    let account: Account;
    if (args.reauth) {
      account = this.store.account(label);
      if (account.provider !== provider) throw new Error('Provider mismatch');
    } else {
      if (this.store.accounts().some((a) => a.label === label))
        throw new Error('Account label already exists');
      account = {
        id: uid(),
        label,
        provider,
        identity: null,
        plan: null,
        model: null,
        status: 'login',
        generation: 0,
        lastAssigned: 0,
      };
      const key = await this.runtime.vault.key(account.id, true);
      key.fill(0);
      this.store.saveAccount(account);
    }
    const owner = `login-${uid()}`;
    if (!this.store.lease(account.id, owner)) throw new Error('Account is busy');
    let container: string | undefined;
    try {
      container = `principal-${uid()}`;
      this.store.setContainer(account.id, container);
      await this.runtime.create(account, ConfigSchema.parse(args.config ?? {}), {
        name: container,
        login: provider === 'antigravity',
      });
      this.store.setContainer(account.id, container);
      const login =
        provider === 'codex' ? await this.runtime.call(container, { op: 'login_start' }) : null;
      return { account, owner, container, login };
    } catch (e) {
      await this.safeStopAndRelease(account.id, owner, container);
      throw e;
    }
  }
  async finishLogin(args: any) {
    const a = this.store.account(args.accountId);
    const lease = this.store.leases().find((l) => l.accountId === a.id && l.owner === args.owner);
    if (!lease?.container) throw new Error('Login lease expired');
    try {
      if (args.abort) {
        if (a.status === 'login') {
          a.status = 'auth_required';
          this.store.saveAccount(a);
        }
        return { aborted: true };
      }
      // Preserve provider-owned login state even if identity format inspection fails.
      // The account remains unverified until the checks below complete.
      if (!a.identity) await this.runtime.snapshot(a, lease.container);
      const reported = await adapter(a, this.runtime).inspectAccount(lease.container);
      if (a.identity && reported.identity !== a.identity)
        throw new Error(
          'Reauthentication changed account identity. Register that account under a new label.',
        );
      if (
        reported.identity &&
        this.store
          .accounts()
          .some(
            (x) => x.id !== a.id && x.provider === a.provider && x.identity === reported.identity,
          )
      )
        throw new Error(
          'This account is already registered; duplicate accounts do not add allowance',
        );
      await this.runtime.snapshot(a, lease.container);
      a.identity = reported.identity;
      a.plan = reported.plan;
      if (a.provider === 'codex' && !a.model) {
        try {
          const catalog: any = await adapter(a, this.runtime).listModels(lease.container);
          const defaultModel = catalog.data?.find((m: any) => m.isDefault);
          a.model = defaultModel?.model ?? null;
        } catch {}
      }
      a.status = 'ready';
      this.store.saveAccount(a);
      try {
        this.store.saveQuota(await adapter(a, this.runtime).readQuota(a, lease.container));
        await this.runtime.snapshot(a, lease.container);
      } catch {}
      return a;
    } finally {
      await this.safeStopAndRelease(a.id, args.owner, lease.container);
    }
  }

  async createGoal(args: any) {
    const config = ConfigSchema.parse(args.config ?? {}),
      pool = labelSchema.parse(args.pool),
      accountIds = this.store.pool(pool);
    if (accountIds.length < 2)
      throw new Error('Automatic runs need a supervisor and another worker account');
    const accounts = accountIds.map((id) => this.store.account(id));
    const supervisor = args.supervisor
      ? this.store.account(args.supervisor)
      : accounts.find((a) => a.provider === 'codex' && a.status === 'ready');
    if (!supervisor || supervisor.provider !== 'codex' || !accountIds.includes(supervisor.id))
      throw new Error('Choose a Codex supervisor in the selected pool');
    const goal = z.string().min(1).max(100000).parse(args.goal);
    const { repo, base } = await cleanRepository(args.repo);
    const { exec } = await import('./util.js');
    config.runtime.image = (
      await exec('docker', ['image', 'inspect', config.runtime.image, '--format', '{{.Id}}'])
    ).stdout
      .toString()
      .trim();
    const run: Run = {
      id: uid(),
      repo,
      base,
      accountIds,
      graph: { schemaVersion: 1, pool, goal, tasks: [] },
      config,
      status: 'planning',
      createdAt: now(),
      integration: null,
      integrationCommit: null,
      error: null,
      supervisor: { accountId: supervisor.id, rounds: 0 },
    };
    await this.repo.prepare(run);
    this.store.saveRun(run);
    this.store.event(run.id, 'planning_started', { goal, pool, supervisor: supervisor.label });
    this.launchPlan(run);
    return run;
  }
  launchPlan(run: Run) {
    if (this.planningJobs.has(run.id)) return;
    this.planningJobs.add(run.id);
    void (async () => {
      let handoffs = 0;
      while (this.store.run(run.id).status === 'planning') {
        const task: TaskRecord = {
          runId: run.id,
          id: 'planner',
          spec: {
            id: 'planner',
            instruction: 'Plan work',
            mode: 'read',
            dependsOn: [],
            writePaths: [],
            expectedOutputs: ['summary'],
            provider: 'codex',
            allowFallback: true,
          },
          status: 'pending',
          checkpoint: null,
          result: null,
          attempts: 1,
          handoffs,
          lastAccount: run.supervisor!.accountId,
        };
        const account = selectAccount(
          task,
          run.accountIds.map((id) => this.store.account(id)),
          (id) => this.store.quota(id),
          new Set(this.store.leases().map((l) => l.accountId)),
          run.config,
        );
        if (!account) {
          run.error = 'Waiting for an eligible supervisor account and fresh quota';
          this.store.saveRun(run);
          await sleep(5000);
          continue;
        }
        run.supervisor!.accountId = account.id;
        this.store.saveRun(run);
        try {
          const graph = await this.plan({
            goal: run.graph.goal,
            pool: run.graph.pool,
            account: account.id,
            repo: run.repo,
            config: run.config,
            snapshotRun: run,
          });
          if (this.store.run(run.id).status === 'canceled') return;
          if (
            graph.tasks.some((t: Graph['tasks'][number]) =>
              t.expectedOutputs.includes('validation'),
            ) &&
            !run.config.validation.length
          )
            throw new Error(
              'The generated graph expects validation; configure project validation commands and start a new run',
            );
          run.graph = validateGraph(graph);
          run.status = 'queued';
          run.error = null;
          this.store.transaction(() => {
            this.store.saveRun(run);
            for (const spec of run.graph.tasks)
              this.store.saveTask({
                runId: run.id,
                id: spec.id,
                spec,
                status: 'pending',
                checkpoint: null,
                result: null,
                attempts: 0,
                handoffs: 0,
                lastAccount: null,
              });
            this.store.event(run.id, 'plan_completed', { graph: run.graph });
          });
          return;
        } catch (e) {
          if (this.store.run(run.id).status === 'canceled') return;
          const message = redact((e as Error).message),
            failure = classifyProviderFailure((e as any).providerError);
          if (
            (failure === 'quota' || failure === 'auth') &&
            handoffs++ < run.config.routing.maxHandoffs
          ) {
            if (failure === 'auth') {
              account.status = 'auth_required';
              this.store.saveAccount(account);
            } else {
              this.blockQuota(account, account.model, message);
            }
            continue;
          }
          if (failure === 'policy') {
            account.status = 'disabled';
            this.store.saveAccount(account);
          }
          throw e;
        }
      }
    })()
      .catch((e) => {
        if (this.store.run(run.id).status !== 'canceled') {
          run.status = 'needs_review';
          run.error = redact((e as Error).message);
          this.store.saveRun(run);
          this.store.event(run.id, 'planning_failed', { error: run.error });
        }
      })
      .finally(() => this.planningJobs.delete(run.id));
  }

  async createRun(args: any) {
    const graph = validateGraph(args.graph),
      config = ConfigSchema.parse(args.config ?? {});
    const { exec } = await import('./util.js');
    config.runtime.image = (
      await exec('docker', ['image', 'inspect', config.runtime.image, '--format', '{{.Id}}'])
    ).stdout
      .toString()
      .trim();
    if (
      graph.tasks.some((t) => t.expectedOutputs.includes('validation')) &&
      !config.validation.length
    )
      throw new Error('Tasks expecting validation require configured project validation commands');
    const ids: string[] = args.accountIds
      ? z.array(z.string()).min(1).parse(args.accountIds)
      : this.store.pool(graph.pool);
    if (!ids.length) throw new Error('Pool is empty');
    ids.forEach((id) => this.store.account(id));
    const { repo, base } = await cleanRepository(args.repo);
    const run: Run = {
      id: uid(),
      sessionId: args.sessionId,
      repo,
      base,
      accountIds: ids,
      graph,
      config,
      status: 'queued',
      createdAt: now(),
      integration: null,
      integrationCommit: null,
      error: null,
    };
    if (args.supervisorAccountId) {
      const a = this.store.account(args.supervisorAccountId);
      if (!ids.includes(a.id) || a.provider !== 'codex' || ids.length < 2)
        throw new Error(
          'Automatic runs need a Codex supervisor and at least one other worker account in the pool',
        );
      run.supervisor = { accountId: a.id, rounds: 0 };
    }
    await this.repo.prepare(run);
    this.store.transaction(() => {
      this.store.saveRun(run);
      for (const task of graph.tasks)
        this.store.saveTask({
          runId: run.id,
          id: task.id,
          spec: task,
          status: 'pending',
          checkpoint: null,
          result: null,
          attempts: 0,
          handoffs: 0,
          lastAccount: null,
        });
      this.store.event(run.id, 'run_created', { base, pool: graph.pool });
    });
    return run;
  }
  async dispatch(run: Run, task: TaskRecord, account: Account) {
    const attempt: Attempt = {
      id: uid(),
      runId: run.id,
      taskId: task.id,
      accountId: account.id,
      container: '',
      workspace: '',
      status: 'starting',
      cursor: 0,
      startedAt: now(),
      sessionId: null,
      model: task.spec.model ?? account.model,
    };
    attempt.container = `principal-${attempt.id}`;
    if (!this.store.lease(account.id, attempt.id, attempt.container)) return;
    this.store.transaction(() => {
      task.status = 'running';
      task.attempts++;
      task.lastAccount = account.id;
      this.store.saveTask(task);
      this.store.saveAttempt(attempt);
      account.lastAssigned = Date.now();
      this.store.saveAccount(account);
      this.store.event(
        run.id,
        'dispatch_intent',
        { account: account.label, model: attempt.model },
        task.id,
        attempt.id,
      );
    });
    try {
      attempt.workspace = await this.repo.workspace(
        run,
        task,
        attempt.id,
        this.store.tasks(run.id),
      );
      this.store.saveAttempt(attempt);
      await this.runtime.create(account, run.config, {
        name: attempt.container,
        workspace: attempt.workspace,
        readOnly: task.spec.mode === 'read',
        runId: run.id,
        attemptId: attempt.id,
      });
      const prior = this.store
        .attempts(run.id)
        .filter((a) => a.taskId === task.id && a.id !== attempt.id)
        .at(-1);
      const resumeSession = prior?.accountId === account.id ? prior.sessionId : null;
      const priorUsage = prior
        ? (this.store.db
            .prepare(
              'SELECT data FROM events WHERE attempt_id=? AND type=? ORDER BY seq DESC LIMIT 1',
            )
            .get(prior.id, 'usage') as { data: string } | undefined)
        : undefined;
      const previousUsage = resumeSession && priorUsage ? JSON.parse(priorUsage.data).usage : null;
      const previous = task.result
        ? `\nPrevious checkpoint summary: ${task.result}\nChanges from the prior attempt are already present. Inspect them before continuing. Do not repeat uncertain external side effects.`
        : '';
      const prompt = `You are a Principal worker for task ${task.id}. Work only in /workspace. Write only these paths: ${task.spec.writePaths.join(', ') || '(read only)'}. Do not invoke other coding agents or spawn subagents. Do not deploy, publish, alter account settings, or access other accounts. Return the required JSON result, and report blocked if a required permission or action cannot be completed.\n\nTask: ${task.spec.instruction}${previous}${task.reportRepairs ? '\nCoordinator: previous work is already checkpointed. This is a report correction. Inspect existing files and return the exact required JSON result; do not rerun the original actions or external effects. Report blocked if work is incomplete.' : ''}`;
      await this.runtime.call(attempt.container, {
        op: 'start',
        attemptId: attempt.id,
        provider: account.provider,
        model: attempt.model,
        resumeSession,
        previousUsage,
        mode: task.spec.mode,
        prompt,
        outputSchema: resultSchema,
        setup: run.config.setup,
        timeoutSeconds: run.config.attemptTimeoutSeconds,
      });
      attempt.status = 'running';
      this.store.saveAttempt(attempt);
    } catch (e) {
      if (this.store.run(run.id).status === 'canceled') {
        attempt.status = 'canceled';
        this.store.saveAttempt(attempt);
        await this.safeStopAndRelease(account.id, attempt.id, attempt.container);
        return;
      }
      attempt.status = 'failed';
      this.store.saveAttempt(attempt);
      task.status = 'needs_review';
      this.store.saveTask(task);
      run.status = 'needs_review';
      run.error = redact((e as Error).message);
      this.store.saveRun(run);
      this.store.event(run.id, 'dispatch_failed', { error: run.error }, task.id, attempt.id);
      try {
        await this.safeStopAndRelease(account.id, attempt.id, attempt.container);
      } catch (cleanup) {
        run.error += `; cleanup failed, account lease retained: ${redact((cleanup as Error).message)}`;
        this.store.saveRun(run);
        throw cleanup;
      }
    }
  }
  async collect(attempt: Attempt) {
    const run = this.store.run(attempt.runId),
      task = this.store.tasks(run.id).find((t) => t.id === attempt.taskId)!;
    let response: any;
    try {
      response = await this.runtime.call(attempt.container, {
        op: 'status',
        after: attempt.cursor,
      });
    } catch (e) {
      if (await this.runtime.exists(attempt.container)) return;
      attempt.status = 'needs_review';
      this.store.saveAttempt(attempt);
      task.status = 'needs_review';
      this.store.saveTask(task);
      run.status = 'needs_review';
      run.error = 'Runtime disappeared with an uncertain outcome';
      this.store.saveRun(run);
      await this.safeStopAndRelease(attempt.accountId, attempt.id, attempt.container);
      return;
    }
    const account = this.store.account(attempt.accountId);
    this.store.transaction(() => {
      for (const event of response.events ?? []) {
        if (event.seq <= attempt.cursor) continue;
        this.store.event(run.id, event.type, event.data, task.id, attempt.id);
        attempt.cursor = event.seq;
        if (event.type === 'session') attempt.sessionId = event.data.sessionId;
        if (event.type === 'quota' && account.provider === 'codex')
          this.store.saveQuota(codexQuota(account.id, event.data));
      }
      this.store.saveAttempt(attempt);
    });
    if (response.events?.length === 1000) return;
    const state = response.status;
    if (this.store.run(run.id).status === 'canceled') return;
    if (!state || !['completed', 'failed'].includes(state.state)) {
      if (Date.now() - (attempt.checkpointAt ?? 0) > 60000) {
        try {
          const checkpoint = await this.repo.checkpoint(
            run,
            task,
            attempt.id,
            attempt.workspace,
            this.store.tasks(run.id),
          );
          task.checkpoint = checkpoint.file;
          task.checkpointHash = checkpoint.hash;
          this.store.saveTask(task);
          await this.runtime.snapshot(account, attempt.container);
          attempt.checkpointAt = Date.now();
          this.store.saveAttempt(attempt);
        } catch (e) {
          attempt.checkpointAt = Date.now();
          this.store.saveAttempt(attempt);
          this.store.event(
            run.id,
            'checkpoint_deferred',
            { error: redact((e as Error).message) },
            task.id,
            attempt.id,
          );
        }
      }
      if (
        Date.now() - Date.parse(attempt.startedAt) >
        run.config.attemptTimeoutSeconds * 1000 + 300000
      ) {
        await this.runtime.stop(attempt.container);
        attempt.status = 'needs_review';
        task.status = 'needs_review';
        run.status = 'needs_review';
        run.error = 'Attempt exceeded its runtime deadline';
        this.store.saveAttempt(attempt);
        this.store.saveTask(task);
        this.store.saveRun(run);
        this.store.release(account.id, attempt.id);
      }
      return;
    }
    if (this.finishing.has(attempt.id)) return;
    this.finishing.add(attempt.id);
    try {
      // Stop the vendor before collecting changes and credentials; the helper remains available.
      const checkpoint = await this.repo.checkpoint(
        run,
        task,
        attempt.id,
        attempt.workspace,
        this.store.tasks(run.id),
      );
      task.checkpoint = checkpoint.file;
      task.checkpointHash = checkpoint.hash;
      task.result = state.result
        ? redact(typeof state.result === 'string' ? state.result : JSON.stringify(state.result))
        : (state.error ?? null);
      await this.runtime.snapshot(account, attempt.container);
      if (this.store.run(run.id).status === 'canceled') return;
      let success = state.state === 'completed';
      let structured: any;
      let invalidReport = false;
      if (success) {
        try {
          structured = ResultSchema.parse(
            typeof state.result === 'string' ? JSON.parse(state.result) : state.result,
          );
          if (structured.status !== 'completed') success = false;
          if (task.spec.expectedOutputs.includes('patch') && !checkpoint.files.length)
            success = false;
        } catch {
          invalidReport = true;
          success = false;
        }
      }
      attempt.status = success ? 'completed' : 'failed';
      if (success) task.status = 'completed';
      else {
        const failure = classifyProviderFailure(state.providerError);
        if (failure === 'quota') {
          this.blockQuota(
            account,
            attempt.model,
            'Provider reported exhaustion; waiting for a fresh probe',
          );
          task.handoffs++;
          task.status =
            task.spec.allowFallback && task.handoffs <= run.config.routing.maxHandoffs
              ? 'pending'
              : 'needs_review';
        } else if (failure === 'auth') {
          account.status = 'auth_required';
          this.store.saveAccount(account);
          task.handoffs++;
          task.status =
            task.spec.allowFallback && task.handoffs <= run.config.routing.maxHandoffs
              ? 'pending'
              : 'needs_review';
        } else if (failure === 'policy') {
          account.status = 'disabled';
          this.store.saveAccount(account);
          task.status = 'needs_review';
          run.error = 'Provider account restriction: routing stopped for review';
        } else if (failure === 'model') {
          task.excludedAccounts = [...new Set([...(task.excludedAccounts ?? []), account.id])];
          task.handoffs++;
          task.status =
            task.spec.allowFallback && task.handoffs <= run.config.routing.maxHandoffs
              ? 'pending'
              : 'needs_review';
        } else if (
          failure === 'transient' &&
          (task.transientRetriesUsed ?? 0) < run.config.routing.transientRetries
        ) {
          task.status = 'pending';
          task.transientRetriesUsed = (task.transientRetriesUsed ?? 0) + 1;
          const seconds = Number(
            (state.error ?? '').match(/retry[ _-]?after[^0-9]*(\d+)/i)?.[1] ?? 30,
          );
          task.notBefore = Date.now() + Math.min(Math.max(seconds, 1), 3600) * 1000;
          account.retryAfter = task.notBefore;
          this.store.saveAccount(account);
        } else if (
          run.sessionId &&
          invalidReport &&
          state.state === 'completed' &&
          (task.reportRepairs ?? 0) < run.config.supervisor.revisionRounds
        ) {
          task.reportRepairs = (task.reportRepairs ?? 0) + 1;
          task.status = 'pending';
          this.store.event(
            run.id,
            'result_repair_requested',
            {
              round: task.reportRepairs,
              reason:
                'Completed native result did not satisfy the result schema; inspect the preserved checkpoint without repeating effects',
            },
            task.id,
            attempt.id,
          );
        } else task.status = 'needs_review';
      }
      this.store.transaction(() => {
        this.store.saveTask(task);
        this.store.saveAttempt(attempt);
        this.store.event(
          run.id,
          'attempt_finished',
          {
            status: attempt.status,
            files: checkpoint.files,
            error:
              state.error ??
              (!success ? (structured?.summary ?? 'Invalid or incomplete task result') : null),
          },
          task.id,
          attempt.id,
        );
        if (task.status === 'needs_review') {
          run.status = 'needs_review';
          this.store.saveRun(run);
        }
      });
      await this.safeStopAndRelease(account.id, attempt.id, attempt.container);
    } catch (e) {
      if (this.store.run(run.id).status === 'canceled') return;
      run.status = 'needs_review';
      run.error = redact((e as Error).message);
      task.status = 'needs_review';
      attempt.status = 'needs_review';
      this.store.saveRun(run);
      this.store.saveTask(task);
      this.store.saveAttempt(attempt);
      await this.runtime.stop(attempt.container).catch(() => {});
      if (!(await this.runtime.exists(attempt.container)))
        this.store.release(account.id, attempt.id);
    } finally {
      this.finishing.delete(attempt.id);
    }
  }
  async finalize(run: Run) {
    try {
      if (!run.integrationCommit || run.checkedCommit !== run.integrationCommit)
        await this.integrate(run);
      if (
        run.supervisor &&
        run.integrationCommit &&
        run.checkedCommit === run.integrationCommit &&
        !['canceled', 'needs_review'].includes(this.store.run(run.id).status)
      ) {
        run.status = 'running';
        this.store.saveRun(run);
        await this.supervise(run);
      }
    } catch (e) {
      if (this.store.run(run.id).status !== 'canceled') {
        run.status = 'needs_review';
        run.error = redact((e as Error).message);
        this.store.saveRun(run);
      }
    }
  }
  async integrate(run: Run, base?: string) {
    run.checkedCommit = null;
    this.store.saveRun(run);
    try {
      const result = await this.repo.integrate(run, this.store.tasks(run.id), base);
      run.integration = result.workspace;
      run.integrationCommit = result.commit;
      if (base)
        run.base = (
          await git(result.workspace, ['rev-parse', `${result.commit}~${run.graph.tasks.length}`])
        ).stdout
          .toString()
          .trim();
      for (const argv of [...run.config.setup, ...run.config.validation]) {
        await this.validateCommand(run, argv);
      }
      if (this.store.run(run.id).status === 'canceled') return this.store.run(run.id);
      run.checkedCommit = run.integrationCommit;
      run.status = 'ready_for_review';
      run.error = null;
      this.store.saveRun(run);
      this.store.event(run.id, 'ready_for_review', {
        commit: result.commit,
        validationCommands: run.config.validation.length,
      });
    } catch (e) {
      if (this.store.run(run.id).status === 'canceled') return this.store.run(run.id);
      run.status = 'needs_review';
      run.error = redact((e as Error).message);
      this.store.saveRun(run);
      this.store.event(run.id, 'integration_failed', { error: run.error });
    }
    return run;
  }
  async validateCommand(run: Run, argv: string[]) {
    if (!run.integration) throw new Error('Missing integration');
    const name = `principal-validation-${uid()}`;
    const actor = await this.runtime.executionUser();
    const args = [
      'create',
      '--network',
      await this.runtime.ensureNetwork(),
      '--name',
      name,
      '--label',
      'principal.managed=true',
      '--label',
      `principal.run=${run.id}`,
      '--user',
      `${actor.uid}:${actor.gid}`,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      String(run.config.runtime.pids),
      '--memory',
      `${run.config.runtime.memoryMiB}m`,
      '--cpus',
      String(Math.min(run.config.runtime.cpus, availableParallelism())),
      '--tmpfs',
      `/home/principal:uid=${actor.uid},gid=${actor.gid},mode=0700`,
      '--tmpfs',
      '/tmp:mode=1777',
      '--mount',
      `type=bind,src=${run.integration},dst=/workspace`,
      '--mount',
      `type=bind,src=${run.integration}/.git,dst=/workspace/.git,readonly`,
      ...this.runtime.connectionArgs(run.config),
      '--workdir',
      '/workspace',
      '--entrypoint',
      argv[0],
      run.config.runtime.image,
      ...argv.slice(1),
    ];
    const { exec } = await import('./util.js');
    try {
      await this.runtime.allocate(run.config.runtime.memoryMiB, async () => {
        await exec('docker', args);
        await exec('docker', ['start', name]);
      });
      const finished = await exec('docker', ['wait', name], {
        timeout: run.config.attemptTimeoutSeconds * 1000,
      });
      const result = await exec('docker', ['logs', name]);
      if (Number(finished.stdout.toString().trim()) !== 0)
        throw new Error(
          `Validation failed: ${argv.join(' ')}\n${redact((result.stdout.toString() + result.stderr.toString()).slice(-8000))}`,
        );
      this.store.event(run.id, 'validation', {
        command: argv,
        output: redact(result.stdout.toString().slice(-8000)),
      });
    } finally {
      await this.runtime.stop(name);
    }
    if ((await git(run.integration, ['status', '--porcelain'])).stdout.length)
      throw new Error(
        'Validation changed the reviewed source tree; review and repair before applying',
      );
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const a of this.store.attempts().filter((a) => a.status === 'running'))
        await this.locks.with(a.runId, () => this.collect(a));
      await this.native.tick();
      const idleConfig = ConfigSchema.parse({});
      for (const a of this.store
        .accounts()
        .filter(
          (a) => a.status === 'ready' && !this.store.leases().some((l) => l.accountId === a.id),
        )) {
        const q = this.store.quota(a.id);
        if (!q || Date.now() - Date.parse(q.observedAt) > 300000) this.scheduleProbe(a, idleConfig);
      }
      await this.sessions.tick();
      const active = this.store
        .attempts()
        .filter((a) => ['starting', 'running'].includes(a.status));
      let activeCount =
        this.native.list().length +
        active.length +
        this.store
          .leases()
          .filter((l) =>
            this.store.sessions().some((s) => this.store.turns(s.id).some((t) => t.id === l.owner)),
          ).length;
      const busy = new Set(this.store.leases().map((l) => l.accountId));
      for (const candidate of this.store
        .runs()
        .filter((r) => ['queued', 'running', 'waiting_quota'].includes(r.status))) {
        await this.locks.with(candidate.id, async () => {
          const run = this.store.run(candidate.id);
          if (!['queued', 'running', 'waiting_quota'].includes(run.status)) return;
          const tasks = this.store.tasks(run.id);
          if (tasks.every((t) => t.status === 'completed')) {
            if (!this.integrationJobs.has(run.id)) {
              this.integrationJobs.add(run.id);
              void this.finalize(run).finally(() => this.integrationJobs.delete(run.id));
            }
            return;
          }
          const accounts = run.accountIds.map((id) => this.store.account(id));
          const ready = tasks.filter(
            (t) =>
              t.status === 'pending' &&
              (!t.notBefore || t.notBefore <= Date.now()) &&
              t.spec.dependsOn.every(
                (id) => tasks.find((x) => x.id === id)?.status === 'completed',
              ),
          );
          let slots =
            Math.min(
              run.config.routing.workers,
              Math.floor((totalmem() * 0.75) / (run.config.runtime.memoryMiB * 1024 * 1024)),
            ) - activeCount;
          for (const task of ready) {
            if (slots <= 0 || !(await this.runtime.hasCapacity(run.config.runtime.memoryMiB)))
              break;
            for (const a of accounts.filter((a) => a.status === 'ready' && !busy.has(a.id))) {
              const q = this.store.quota(a.id);
              if (
                !q ||
                Date.now() - Date.parse(q.observedAt) > run.config.routing.quotaMaxAgeSeconds * 1000
              ) {
                this.scheduleProbe(a, run.config);
                if (this.probeJobs.has(a.id)) busy.add(a.id);
              }
            }
            // Unverified identities cannot establish independent allowance: serialize them by provider.
            const unavailable = new Set(busy);
            if (run.supervisor) unavailable.add(run.supervisor.accountId);
            for (const a of accounts)
              if (
                !a.identity &&
                accounts.some((b) => busy.has(b.id) && b.provider === a.provider && !b.identity)
              )
                unavailable.add(a.id);
            const account = selectAccount(
              task,
              accounts,
              (id) => this.store.quota(id),
              unavailable,
              run.config,
              this.excluded.get(`${run.id}/${task.id}`),
            );
            if (!account) {
              run.status = 'waiting_quota';
              this.store.saveRun(run);
              continue;
            }
            run.status = 'running';
            this.store.saveRun(run);
            await this.dispatch(run, task, account);
            busy.add(account.id);
            slots--;
            activeCount++;
          }
        });
      }
    } finally {
      this.ticking = false;
    }
  }
  async cancel(run: Run) {
    run.status = 'canceled';
    this.store.saveRun(run);
    for (const attempt of this.store
      .attempts(run.id)
      .filter((a) => ['starting', 'running'].includes(a.status))) {
      await this.runtime.call(attempt.container, { op: 'cancel' }).catch(() => {});
      await sleep(300);
      try {
        const task = this.store.tasks(run.id).find((t) => t.id === attempt.taskId)!;
        const checkpoint = await this.repo.checkpoint(
          run,
          task,
          attempt.id,
          attempt.workspace,
          this.store.tasks(run.id),
        );
        task.checkpoint = checkpoint.file;
        task.checkpointHash = checkpoint.hash;
        this.store.saveTask(task);
        await this.runtime.snapshot(this.store.account(attempt.accountId), attempt.container);
      } catch {}
      await this.runtime.stop(attempt.container);
      attempt.status = 'canceled';
      this.store.saveAttempt(attempt);
      this.store.release(attempt.accountId, attempt.id);
    }
    for (const lease of this.store
      .leases()
      .filter(
        (l) => l.owner.startsWith(`supervisor-${run.id}-`) || l.owner.startsWith(`plan-${run.id}-`),
      )) {
      if (lease.container) await this.runtime.stop(lease.container);
      this.store.release(lease.accountId, lease.owner);
    }
    const { exec } = await import('./util.js');
    const containers = (
      await exec('docker', [
        'ps',
        '-a',
        '--filter',
        `label=principal.run=${run.id}`,
        '--format',
        '{{.Names}}',
      ])
    ).stdout
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const name of containers) await this.runtime.stop(name).catch(() => {});
    for (const t of this.store.tasks(run.id)) {
      if (t.status !== 'completed') {
        t.status = 'canceled';
        this.store.saveTask(t);
      }
    }
    this.store.event(run.id, 'canceled', {});
    return run;
  }
  async plan(args: any) {
    const config = ConfigSchema.parse(args.config ?? {});
    const accounts: Account[] = (
      args.snapshotRun?.accountIds ?? this.store.pool(labelSchema.parse(args.pool))
    ).map((id: string) => this.store.account(id));
    const account = args.account
      ? this.store.account(args.account)
      : accounts.find((a) => a.provider === 'codex' && a.status === 'ready');
    if (!account || !accounts.some((a) => a.id === account.id))
      throw new Error('Choose an eligible Codex supervisor account in the selected pool');
    if (account.provider !== 'codex')
      throw new Error(
        'Antigravity automatic supervisor mode needs a verified native-spawn restriction; use explicit tasks for that provider',
      );
    const { repo, base } = args.snapshotRun ?? (await cleanRepository(args.repo));
    const id = uid(),
      dir = path.join(paths.runs, `plan-${id}`),
      workspace = path.join(dir, 'workspace');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const bundle = args.snapshotRun
      ? path.join(this.repo.runDir(args.snapshotRun.id), 'base.bundle')
      : path.join(dir, 'base.bundle');
    if (!args.snapshotRun) await git(repo, ['bundle', 'create', bundle, 'HEAD']);
    await git(dir, ['clone', '--quiet', bundle, workspace]);
    await git(workspace, ['checkout', '--quiet', '--detach', base]);
    const bridge = new SupervisorBridge(
      path.join(dir, 'bridge'),
      args.pool,
      config.supervisor.maxTasks,
      () => [],
      async () => {
        throw new Error('No running tasks in a draft plan');
      },
    );
    await bridge.start();
    const owner = args.snapshotRun ? `plan-${args.snapshotRun.id}-${id}` : `plan-${id}`;
    if (!this.store.lease(account.id, owner)) {
      await bridge.stop();
      throw new Error('Supervisor account is busy');
    }
    let container: string | undefined;
    try {
      container = `principal-${uid()}`;
      this.store.setContainer(account.id, container);
      await this.runtime.create(account, config, {
        name: container,
        workspace,
        readOnly: true,
        bridge: bridge.directory,
        runId: args.snapshotRun?.id,
      });
      this.store.setContainer(account.id, container);
      if (args.snapshotRun && this.store.run(args.snapshotRun.id).status === 'canceled')
        throw new Error('Planning canceled');
      const prompt = `Plan repository work for this goal: ${args.goal}. Return a JSON DAG matching the output schema. schemaVersion=1, pool=${args.pool}. At most ${config.supervisor.maxTasks} tasks. Each writing task needs explicit writePaths. Dependencies must be acyclic. Only inspect the repository; do not edit, deploy, publish, spawn subagents, or perform account operations. Group overlapping edits into one task or dependency-order them. Current base: ${base}.`;
      await this.runtime.call(container, {
        op: 'start',
        attemptId: id,
        provider: 'codex',
        model: account.model,
        mode: 'read',
        prompt,
        outputSchema: graphOutputSchema,
        setup: [],
        timeoutSeconds: config.attemptTimeoutSeconds,
      });
      const deadline = Date.now() + config.attemptTimeoutSeconds * 1000 + 30000;
      for (;;) {
        if (Date.now() > deadline) throw new Error('Planning deadline exceeded');
        if (args.snapshotRun && this.store.run(args.snapshotRun.id).status === 'canceled')
          throw new Error('Planning canceled');
        await sleep(1000);
        const r = await this.runtime.call(container, { op: 'status', after: 0 });
        if (r.status?.state === 'failed')
          throw Object.assign(new Error(r.status.error), { providerError: r.status.providerError });
        if (r.status?.state === 'completed') {
          const graph = bridge.proposal ?? validateGraph(JSON.parse(r.status.result));
          if (graph.pool !== args.pool || graph.tasks.length > config.supervisor.maxTasks)
            throw new Error('Supervisor exceeded the approved plan bounds');
          await this.runtime.snapshot(account, container);
          return { ...graph, goal: args.goal };
        }
      }
    } finally {
      try {
        await this.safeStopAndRelease(account.id, owner, container);
      } finally {
        await bridge.stop();
        await rm(dir, { recursive: true, force: true });
      }
    }
  }

  async supervise(run: Run) {
    const supervisor = run.supervisor!;
    let account = this.store.account(supervisor.accountId);
    const supervisorTask: TaskRecord = {
      runId: run.id,
      id: 'supervisor',
      spec: {
        id: 'supervisor',
        instruction: 'Review run',
        mode: 'read',
        dependsOn: [],
        writePaths: [],
        expectedOutputs: ['summary'],
        provider: 'codex',
        allowFallback: true,
      },
      status: 'pending',
      checkpoint: null,
      result: null,
      attempts: 1,
      handoffs: 0,
      lastAccount: supervisor.accountId,
    };
    const eligible = selectAccount(
      supervisorTask,
      run.accountIds.map((id) => this.store.account(id)),
      (id) => this.store.quota(id),
      new Set(this.store.leases().map((l) => l.accountId)),
      run.config,
    );
    if (!eligible) {
      run.status = 'waiting_quota';
      this.store.saveRun(run);
      return;
    }
    account = eligible;
    supervisor.accountId = account.id;
    this.store.saveRun(run);
    if (account.status !== 'ready') {
      run.status = 'needs_review';
      run.error = 'Supervisor account requires authentication';
      this.store.saveRun(run);
      return;
    }
    const bridge = new SupervisorBridge(
      path.join(this.repo.runDir(run.id), 'supervisor-bridge'),
      run.graph.pool,
      run.config.supervisor.maxTasks,
      () => this.store.tasks(run.id),
      async (id) => {
        const task = this.store.tasks(run.id).find((t) => t.id === id)!;
        if (task.status === 'completed') throw new Error('Completed tasks cannot be canceled');
        task.status = 'canceled';
        this.store.saveTask(task);
      },
    );
    await bridge.start();
    const owner = `supervisor-${run.id}-${uid()}`;
    if (!this.store.lease(account.id, owner)) {
      await bridge.stop();
      run.status = 'waiting_quota';
      this.store.saveRun(run);
      return;
    }
    let container: string | undefined;
    try {
      container = await this.runtime.create(account, run.config, {
        workspace: run.integration!,
        readOnly: true,
        bridge: bridge.directory,
        runId: run.id,
      });
      this.store.setContainer(account.id, container);
      if (this.store.run(run.id).status === 'canceled') throw new Error('Run canceled');
      const prompt = `Review the completed Principal run for goal: ${run.graph.goal ?? 'Complete the approved task graph'}. Inspect the repository and use principal MCP tools to read task results and patches. Do not spawn subagents. If the work satisfies the goal, return decision accept. If follow-up work is needed, call propose_task_revision with a graph containing the original task specifications plus new dependency-ordered tasks, then return decision revise. Do not rewrite existing task specifications. New tasks must stay within the original approved write paths and pool ${run.graph.pool}. Maximum total tasks ${run.config.supervisor.maxTasks}; revision rounds remaining ${run.config.supervisor.revisionRounds - supervisor.rounds}. Return blocked if completion requires additional authorization or scope.`;
      await this.runtime.call(container, {
        op: 'start',
        attemptId: owner,
        provider: 'codex',
        model: account.model,
        mode: 'read',
        prompt,
        outputSchema: supervisorReviewSchema,
        setup: [],
        timeoutSeconds: run.config.attemptTimeoutSeconds,
      });
      let final: any;
      const deadline = Date.now() + run.config.attemptTimeoutSeconds * 1000 + 30000;
      while (Date.now() < deadline) {
        await sleep(1000);
        const result = await this.runtime.call(container, { op: 'status', after: 0 });
        if (result.status?.state === 'failed')
          throw Object.assign(new Error(result.status.error), {
            providerError: result.status.providerError,
          });
        if (result.status?.state === 'completed') {
          final = JSON.parse(result.status.result);
          break;
        }
      }
      if (!final) throw new Error('Supervisor deadline exceeded');
      await this.runtime.snapshot(account, container);
      this.store.event(run.id, 'supervisor_review', final);
      if (this.store.run(run.id).status === 'canceled') return;
      if (final.decision === 'accept') {
        run.status = 'ready_for_review';
        this.store.saveRun(run);
        return;
      }
      if (
        final.decision !== 'revise' ||
        !bridge.proposal ||
        supervisor.rounds >= run.config.supervisor.revisionRounds
      )
        throw new Error(
          final.summary ?? 'Supervisor could not complete within its revision budget',
        );
      const graph = bridge.proposal,
        original = new Map(run.graph.tasks.map((t) => [t.id, t]));
      if (
        graph.tasks.length < original.size ||
        graph.tasks.some(
          (t) => original.has(t.id) && JSON.stringify(original.get(t.id)) !== JSON.stringify(t),
        )
      )
        throw new Error('Supervisor changed an approved existing task');
      for (const id of original.keys())
        if (!graph.tasks.some((t) => t.id === id))
          throw new Error('Supervisor removed an approved task');
      const approved = new Set(run.graph.tasks.flatMap((t) => t.writePaths));
      const added = graph.tasks.filter((t) => !original.has(t.id));
      if (!added.length || added.some((t) => t.writePaths.some((p) => !approved.has(p))))
        throw new Error('Follow-up tasks exceeded the approved write paths');
      graph.goal = run.graph.goal;
      run.graph = graph;
      supervisor.rounds++;
      run.status = 'queued';
      run.integration = null;
      run.integrationCommit = null;
      run.checkedCommit = null;
      this.store.transaction(() => {
        this.store.saveRun(run);
        for (const spec of added)
          this.store.saveTask({
            runId: run.id,
            id: spec.id,
            spec,
            status: 'pending',
            checkpoint: null,
            result: null,
            attempts: 0,
            handoffs: 0,
            lastAccount: null,
          });
      });
    } catch (e) {
      if (this.store.run(run.id).status !== 'canceled') {
        const message = redact((e as Error).message),
          failure = classifyProviderFailure((e as any).providerError);
        if (failure === 'quota') {
          this.blockQuota(account, account.model, message);
          run.status = 'waiting_quota';
        } else {
          run.status = 'needs_review';
          if (failure === 'auth') {
            account.status = 'auth_required';
            this.store.saveAccount(account);
          }
          if (failure === 'policy') {
            account.status = 'disabled';
            this.store.saveAccount(account);
          }
        }
        run.error = message;
        this.store.saveRun(run);
      }
    } finally {
      try {
        await this.safeStopAndRelease(account.id, owner, container);
      } finally {
        await bridge.stop();
      }
    }
  }

  async rpc(method: string, args: any): Promise<any> {
    if (method === 'native.open') return this.locks.with(args.sessionId ? `session:${z.string().parse(args.sessionId)}` : 'native.open', () => this.native.open(args));
    if (method === 'native.heartbeat') return this.native.heartbeat(z.string().parse(args.owner));
    if (method === 'native.close') return this.locks.with(z.string().parse(args.owner), () => this.native.close(args.owner));
    if (method === 'protocol') return { version: 2, supported: [1, 2], sessions: true, native: true, nativeWorkingDirectory: true };
    if (
      method === 'sessions.resume' &&
      ['idle', 'queued', 'running', 'waiting_quota', 'waiting_workers'].includes(
        this.store.session(z.string().parse(args.id)).status,
      )
    )
      return this.sessions.rpc(method, args);
    if (method === 'sessions.interrupt') {
      const s = this.store.session(z.string().parse(args.id));
      s.status = 'stopped';
      this.store.saveSession(s);
      await this.sessions.signalInterrupt(s.id);
      return this.locks.with(`session:${s.id}`, () => this.sessions.rpc(method, args));
    }
    if (method.startsWith('sessions.')) {
      if (
        [
          'sessions.prune',
          'sessions.submit',
          'sessions.answer',
          'sessions.interrupt',
          'sessions.apply',
          'sessions.refresh',
          'sessions.configure',
          'sessions.compact',
          'sessions.resume',
          'sessions.review',
        ].includes(method)
      )
        return this.locks.with(`session:${z.string().parse(args.id)}`, () =>
          this.sessions.rpc(method, args),
        );
      return this.sessions.rpc(method, args);
    }
    if (method === 'runs.cancel') {
      const run = this.store.run(args.id);
      run.status = 'canceled';
      this.store.saveRun(run);
      return this.locks.with(run.id, () => this.cancel(this.store.run(run.id)));
    }
    if (['runs.resume', 'runs.integrate', 'runs.apply', 'runs.prune'].includes(method))
      return this.locks.with(z.string().parse(args.id), () => this.handleRpc(method, args));
    return this.handleRpc(method, args);
  }
  private async handleRpc(method: string, args: any): Promise<any> {
    const config = ConfigSchema.parse(args.config ?? {});
    switch (method) {
      case 'accounts.list':
        return this.store.accounts();
      case 'accounts.begin':
        return this.beginLogin(args);
      case 'accounts.loginStatus':
        return this.runtime.call(args.container, { op: 'login_status' });
      case 'accounts.finish':
        return this.finishLogin(args);
      case 'accounts.checkInference': {
        const a = this.store.account(args.account);
        return this.isolated(a, config, `inference-check-${uid()}`, async (c) => {
          await this.runtime.call(c, {
            op: 'start',
            attemptId: uid(),
            provider: a.provider,
            model: a.model,
            mode: 'read',
            prompt:
              'Return JSON with status completed, summary OK, and remainingIssues an empty array. Do not use tools.',
            outputSchema: resultSchema,
            setup: [],
            timeoutSeconds: 60,
          });
          const deadline = Date.now() + 90000;
          while (Date.now() < deadline) {
            await sleep(1000);
            const r = await this.runtime.call(c, { op: 'status', after: 0 });
            if (['completed', 'failed'].includes(r.status?.state))
              return { account: a.label, model: a.model, inferencePerformed: true, ...r.status };
          }
          throw new Error('Inference check timed out');
        });
      }
      case 'accounts.model': {
        const a = this.store.account(args.account);
        if (this.store.leases().some((l) => l.accountId === a.id))
          throw new Error(
            'Account is busy; change its preferred model after the current operation',
          );
        a.model = z.string().min(1).parse(args.model);
        this.store.saveAccount(a);
        return a;
      }
      case 'accounts.remove': {
        const a = this.store.account(args.account);
        if (this.store.leases().some((l) => l.accountId === a.id))
          throw new Error('Cancel active work before removing this account');
        if (this.store.sessions().some((s) => s.accountIds.includes(a.id)))
          throw new Error('Retained sessions reference this account');
        if (this.store.runs().some((r) => r.accountIds.includes(a.id)))
          throw new Error(
            'Prune runs using this account before removing it, to preserve run provenance',
          );
        let revoked = false;
        try {
          revoked = await this.isolated(a, config, `logout-${uid()}`, (c) =>
            adapter(a, this.runtime).logout(c),
          );
        } catch {}
        if (this.store.leases().some((lease) => lease.accountId === a.id))
          throw new Error('Account cleanup is unconfirmed; lease and credentials retained');
        await this.runtime.vault.remove(a.id);
        this.store.db.prepare('DELETE FROM attempts WHERE account_id=?').run(a.id);
        this.store.db.prepare('DELETE FROM accounts WHERE id=?').run(a.id);
        for (const p of this.store.pools())
          this.store.savePool(
            p.name,
            p.accounts.filter((id: string) => id !== a.id),
          );
        return { removed: true, remoteRevocationConfirmed: revoked };
      }
      case 'pools.addAccount': {
        const pool = labelSchema.parse(args.pool);
        const account = this.store.account(z.string().parse(args.account));
        if (account.status !== 'ready')
          throw new Error('Complete account sign-in before adding it to a pool');
        this.store.transaction(() => {
          const existing = this.store.pools().find((p) => p.name === pool)?.accounts ?? [];
          this.store.savePool(pool, [...new Set([...existing, account.id])]);
        });
        return { pool, accountId: account.id };
      }
      case 'pools.list':
        return this.store.pools();
      case 'pools.create': {
        const name = labelSchema.parse(args.name),
          ids = z
            .array(z.string())
            .min(1)
            .parse(args.accounts)
            .map((label) => this.store.account(label).id);
        if (new Set(ids).size !== ids.length) throw new Error('Duplicate accounts');
        this.store.savePool(name, ids);
        return { name, accounts: ids };
      }
      case 'models': {
        const a = this.store.account(args.account);
        return this.isolated(a, config, `models-${uid()}`, (c) =>
          adapter(a, this.runtime).listModels(c),
        );
      }
      case 'usage': {
        const accounts = args.pool
          ? this.store.pool(args.pool).map((id) => this.store.account(id))
          : this.store.accounts();
        const results = [];
        for (const a of accounts) {
          if (
            args.refresh &&
            !this.store.leases().some((l) => l.accountId === a.id) &&
            a.status === 'ready'
          )
            await this.refresh(a, config);
          let quota = this.store.quota(a.id);
          if (
            quota &&
            Date.now() - Date.parse(quota.observedAt) > config.routing.quotaMaxAgeSeconds * 1000
          )
            quota = { ...quota, state: 'stale' };
          results.push({
            account: a,
            quota,
            busy: this.store.leases().some((l) => l.accountId === a.id),
          });
        }
        return results;
      }
      case 'runs.goal':
        return this.createGoal(args);
      case 'runs.create':
        return this.createRun(args);
      case 'runs.list':
        return this.store.runs();
      case 'runs.status':
        return {
          run: this.store.run(args.id),
          tasks: this.store.tasks(args.id),
          attempts: this.store.attempts(args.id),
        };
      case 'runs.events':
        return this.store
          .events(args.id, args.after ?? 0)
          .filter((e) => !args.task || e.taskId === args.task);
      case 'runs.cancel':
        return this.cancel(this.store.run(args.id));
      case 'runs.resume': {
        if (this.integrationJobs.has(args.id) || this.planningJobs.has(args.id))
          throw new Error('Planning, integration, or supervisor review is still active');
        const run = this.store.run(args.id);
        if (['applied', 'ready_for_review'].includes(run.status))
          throw new Error('This run is already complete; review or apply it');
        if (this.store.attempts(run.id).some((a) => ['starting', 'running'].includes(a.status)))
          throw new Error('A worker is still active');
        for (const t of this.store.tasks(run.id)) {
          if (t.status !== 'completed') {
            t.status = 'pending';
            t.transientRetriesUsed = 0;
            t.notBefore = 0;
            t.handoffs = 0;
            t.excludedAccounts = [];
            this.store.saveTask(t);
          }
        }
        run.status = run.graph.tasks.length ? 'queued' : 'planning';
        run.error = null;
        this.store.saveRun(run);
        if (run.status === 'planning') this.launchPlan(run);
        return run;
      }
      case 'runs.integrate': {
        if (this.integrationJobs.has(args.id))
          throw new Error('Integration or supervisor review is still active');
        const run = this.store.run(args.id);
        return this.integrate(run, args.base);
      }
      case 'runs.review': {
        const run = this.store.run(args.id);
        return { run, diff: await this.repo.diff(run), tasks: this.store.tasks(run.id) };
      }
      case 'runs.apply': {
        if (this.store.run(args.id).sessionId)
          throw new Error(
            'Interactive worker runs apply through sessions.apply after session review',
          );
        if (this.integrationJobs.has(args.id)) throw new Error('Supervisor review is still active');
        const run = this.store.run(args.id);
        await this.repo.apply(run);
        run.status = 'applied';
        this.store.saveRun(run);
        return run;
      }
      case 'runs.prune': {
        if (this.integrationJobs.has(args.id) || this.planningJobs.has(args.id))
          throw new Error('Wait for worker, planning, and integration cleanup before pruning');
        const run = this.store.run(args.id);
        if (this.store.attempts(run.id).some((a) => ['starting', 'running'].includes(a.status)))
          throw new Error('Cancel active work first');
        if (['queued', 'running', 'planning', 'waiting_quota'].includes(run.status))
          throw new Error('Cancel or finish active run before pruning');
        const attemptIds = new Set(this.store.attempts(run.id).map((a) => a.id));
        const leases = this.store
          .leases()
          .filter(
            (l) =>
              attemptIds.has(l.owner) ||
              l.owner.startsWith(`supervisor-${run.id}-`) ||
              l.owner.startsWith(`plan-${run.id}-`),
          );
        // Confirm every associated runtime stopped before removing records.
        for (const lease of leases)
          await this.safeStopAndRelease(lease.accountId, lease.owner, lease.container);
        await this.runtime.removeRun(run.id);
        await rm(this.repo.runDir(run.id), { recursive: true, force: true });
        this.store.db.prepare('DELETE FROM runs WHERE id=?').run(run.id);
        return { pruned: true };
      }
      case 'plan':
        return this.plan(args);
      default:
        throw new Error(`Unknown method ${method}`);
    }
  }
}
