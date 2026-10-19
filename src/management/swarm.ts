import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { managementRpc } from './client.js';
import { Tool, type Installation, type Profile, type Snapshot } from './model.js';
import { buildNativeLaunch } from './providers.js';
import { isolatedAntigravityLaunch, removeIsolatedRuntime } from './antigravity-isolation.js';
import { prepareWorkspace, type WorktreeSession } from './worktree.js';

export const SwarmTaskSchema = z.object({
  id: z.string().min(1).default(() => `task-${randomUUID().slice(0, 8)}`),
  task: z.string().min(1, 'Task description cannot be empty'),
  cwd: z.string().optional(),
  isolate_workspace: z.boolean().default(true),
  model: z.string().optional(),
  tool: Tool.optional(),
});

export const SwarmDeploySchema = z.object({
  provider: z.enum(['antigravity', 'codex', 'auto']).default('antigravity'),
  tasks: z.array(SwarmTaskSchema).min(1, 'Must provide at least one task'),
  wait_for_completion: z.boolean().default(true),
  timeout_seconds: z.number().int().min(5).max(3600).default(300),
  max_parallel: z.number().int().min(1).max(32).optional(),
});

export type SwarmTask = z.infer<typeof SwarmTaskSchema>;
export type SwarmDeployOptions = z.infer<typeof SwarmDeploySchema>;

export interface SwarmWorkerResult {
  id: string;
  profileId: string;
  profileLabel: string;
  tool: Tool;
  account: string | null;
  status: 'completed' | 'failed' | 'timeout' | 'cancelled';
  exitCode: number | null;
  durationMs: number;
  output: string;
  error: string;
  worktreeDir?: string;
  gitDiff?: string;
  modifiedFiles?: string[];
}

export interface SwarmResult {
  swarmId: string;
  provider: string;
  status: 'completed' | 'partial' | 'failed' | 'running';
  startedAt: string;
  completedAt?: string;
  workers: SwarmWorkerResult[];
  summary: string;
}

interface ActiveSwarmExecution {
  swarmId: string;
  provider: string;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'completed' | 'partial' | 'failed';
  options: SwarmDeployOptions;
  workers: SwarmWorkerResult[];
  activeProcesses: Set<ChildProcess>;
  abortController: AbortController;
  promise?: Promise<SwarmResult>;
}

const activeSwarms = new Map<string, ActiveSwarmExecution>();
const busyProfilesInSwarms = new Set<string>();

export async function listSwarmProfiles(): Promise<
  Array<{
    id: string;
    label: string;
    tool: Tool;
    auth: string;
    account: string | null;
    isolated: boolean;
    headroom: number | null;
    busy: boolean;
  }>
> {
  const snapshot: Snapshot = await managementRpc('snapshot');
  const activeInvocations = new Set(
    snapshot.invocations.filter((i) => i.lifecycle !== 'exited').map((i) => i.profileId),
  );

  return snapshot.profiles.map((p) => {
    // Find latest quota observation for headroom
    const observations = snapshot.resources.filter((r) => r.profileId === p.id && r.metric === 'quota-remaining');
    const latest = observations.sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
    const headroom = latest ? latest.value : null;
    const isBusy = activeInvocations.has(p.id) || busyProfilesInSwarms.has(p.id);

    return {
      id: p.id,
      label: p.label,
      tool: p.tool,
      auth: p.auth,
      account: p.reportedAccount,
      isolated: p.isolated,
      headroom,
      busy: isBusy,
    };
  });
}

function rankAvailableProfiles(
  profiles: Profile[],
  snapshot: Snapshot,
  toolFilter?: Tool,
): Profile[] {
  const activeInvocations = new Set(
    snapshot.invocations.filter((i) => i.lifecycle !== 'exited').map((i) => i.profileId),
  );

  const eligible = profiles.filter((p) => {
    if (toolFilter && p.tool !== toolFilter) return false;
    if (activeInvocations.has(p.id)) return false;
    if (busyProfilesInSwarms.has(p.id)) return false;
    return true;
  });

  return eligible.sort((a, b) => {
    const aAuth = a.auth === 'authenticated' ? 1 : 0;
    const bAuth = b.auth === 'authenticated' ? 1 : 0;
    if (aAuth !== bAuth) return bAuth - aAuth;

    // Look up headroom
    const aObs = snapshot.resources
      .filter((r) => r.profileId === a.id && r.metric === 'quota-remaining')
      .sort((x, y) => y.observedAt.localeCompare(x.observedAt))[0];
    const bObs = snapshot.resources
      .filter((r) => r.profileId === b.id && r.metric === 'quota-remaining')
      .sort((x, y) => y.observedAt.localeCompare(x.observedAt))[0];

    const aHeadroom = aObs?.value ?? -1;
    const bHeadroom = bObs?.value ?? -1;
    if (aHeadroom !== bHeadroom) return bHeadroom - aHeadroom;

    return a.label.localeCompare(b.label);
  });
}

async function runWorker(
  task: SwarmTask,
  profile: Profile,
  installation: Installation,
  timeoutSeconds: number,
  abortSignal: AbortSignal,
  onProcessSpawn: (proc: ChildProcess) => void,
  onProcessExit: (proc: ChildProcess) => void,
): Promise<SwarmWorkerResult> {
  const start = Date.now();
  let workspace: WorktreeSession | undefined;
  let child: ChildProcess | undefined;
  let launchCleanup: (() => Promise<void>) | undefined;
  let isolatedRuntimeDir: string | undefined;
  let keyringPassword: Buffer | undefined;

  try {
    const baseCwd = task.cwd ?? process.cwd();
    workspace = await prepareWorkspace(baseCwd, task.id, task.isolate_workspace !== false);

    // Build tool-specific command
    let args: string[] = [];
    if (profile.tool === 'antigravity') {
      args = [
        '-p',
        task.task,
        '--dangerously-skip-permissions',
        '--mode',
        'accept-edits',
        ...(task.model ? ['--model', task.model] : []),
      ];
    } else if (profile.tool === 'codex') {
      args = [
        'exec',
        task.task,
        '--dangerously-bypass-approvals-and-sandbox',
        ...(task.model ? ['-m', task.model] : []),
      ];
    } else {
      args = ['-p', task.task];
    }

    const baseSpec = buildNativeLaunch(profile, installation, args);
    let launchSpec = {
      executable: baseSpec.executable,
      args: baseSpec.args,
      env: baseSpec.env,
      keyringPassword: undefined as Buffer | undefined,
      trackNativePid: false,
      cleanup: undefined as (() => Promise<void>) | undefined,
    };

    if (profile.tool === 'antigravity' && profile.isolated) {
      const isolated = await isolatedAntigravityLaunch(profile, baseSpec);
      launchSpec = isolated;
      launchCleanup = isolated.cleanup;
      keyringPassword = isolated.keyringPassword;
      isolatedRuntimeDir = isolated.env.XDG_RUNTIME_DIR;
    }

    if (abortSignal.aborted) {
      return {
        id: task.id,
        profileId: profile.id,
        profileLabel: profile.label,
        tool: profile.tool,
        account: profile.reportedAccount,
        status: 'cancelled',
        exitCode: null,
        durationMs: Date.now() - start,
        output: '',
        error: 'Execution cancelled before startup',
      };
    }

    // Launch child process with captured streams
    child = spawn(launchSpec.executable, [...launchSpec.args], {
      cwd: workspace.worktreeDir,
      env: launchSpec.env,
      stdio: launchSpec.trackNativePid
        ? ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']
        : ['ignore', 'pipe', 'pipe'],
    });

    onProcessSpawn(child);

    // Handle isolated Antigravity password and PID pipes
    if (launchSpec.trackNativePid) {
      const fd3 = child.stdio[3] as Writable;
      fd3.on('error', () => {});
      fd3.end(keyringPassword, () => keyringPassword?.fill(0));

      const fd4 = child.stdio[4] as Readable;
      fd4.on('data', () => {});
    }

    let stdoutBuffer = '';
    let stderrBuffer = '';

    child.stdout?.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      if (stdoutBuffer.length > 32 * 1024 * 1024) {
        stdoutBuffer = stdoutBuffer.slice(-16 * 1024 * 1024);
      }
    });

    child.stderr?.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
      if (stderrBuffer.length > 8 * 1024 * 1024) {
        stderrBuffer = stderrBuffer.slice(-4 * 1024 * 1024);
      }
    });

    // Setup cancellation and timeout listeners
    let timedOut = false;
    let cancelled = false;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child?.kill('SIGTERM');
      setTimeout(() => child?.kill('SIGKILL'), 2000).unref();
    }, timeoutSeconds * 1000);

    const abortHandler = () => {
      cancelled = true;
      child?.kill('SIGTERM');
      setTimeout(() => child?.kill('SIGKILL'), 2000).unref();
    };
    abortSignal.addEventListener('abort', abortHandler, { once: true });

    const [exitCode] = await new Promise<[number | null, NodeJS.Signals | null]>(
      (resolve) => {
        child!.once('exit', (code, sig) => resolve([code, sig]));
        child!.once('error', (err) => {
          stderrBuffer += `\nFailed to spawn process: ${err.message}`;
          resolve([1, null]);
        });
      },
    );

    clearTimeout(timeoutTimer);
    abortSignal.removeEventListener('abort', abortHandler);
    onProcessExit(child);

    const diffResult = await workspace.getDiff().catch(() => ({ diff: '', files: [] }));

    let status: SwarmWorkerResult['status'] = 'completed';
    if (cancelled) status = 'cancelled';
    else if (timedOut) status = 'timeout';
    else if (exitCode !== 0) status = 'failed';

    return {
      id: task.id,
      profileId: profile.id,
      profileLabel: profile.label,
      tool: profile.tool,
      account: profile.reportedAccount,
      status,
      exitCode,
      durationMs: Date.now() - start,
      output: stdoutBuffer.trim(),
      error: stderrBuffer.trim(),
      worktreeDir: workspace.worktreeDir,
      gitDiff: diffResult.diff,
      modifiedFiles: diffResult.files,
    };
  } catch (error) {
    return {
      id: task.id,
      profileId: profile.id,
      profileLabel: profile.label,
      tool: profile.tool,
      account: profile.reportedAccount,
      status: 'failed',
      exitCode: 1,
      durationMs: Date.now() - start,
      output: '',
      error: (error as Error).message,
    };
  } finally {
    keyringPassword?.fill(0);
    await launchCleanup?.().catch(() => {});
    if (isolatedRuntimeDir) {
      await removeIsolatedRuntime(isolatedRuntimeDir).catch(() => {});
    }
    await workspace?.cleanup().catch(() => {});
  }
}

export async function deploySwarm(rawOptions: unknown): Promise<SwarmResult> {
  const options = SwarmDeploySchema.parse(rawOptions);
  const swarmId = randomUUID();
  const startedAt = new Date().toISOString();

  await managementRpc('installations.refresh').catch(() => {});
  const snapshot: Snapshot = await managementRpc('snapshot');

  const toolFilter = options.provider === 'auto' ? undefined : (options.provider as Tool);
  const availableProfiles = rankAvailableProfiles(snapshot.profiles, snapshot, toolFilter);

  if (!availableProfiles.length) {
    throw new Error(
      `No available profiles found for provider '${options.provider}'. Ensure accounts are added and unlocked.`,
    );
  }

  const execution: ActiveSwarmExecution = {
    swarmId,
    provider: options.provider,
    startedAt,
    status: 'running',
    options,
    workers: [],
    activeProcesses: new Set(),
    abortController: new AbortController(),
  };

  activeSwarms.set(swarmId, execution);

  const runAllWorkers = async (): Promise<SwarmResult> => {
    try {
      const tasksQueue = [...options.tasks];
      const maxConcurrency = Math.min(
        options.max_parallel ?? availableProfiles.length,
        availableProfiles.length,
      );

      // Track active worker promises
      const workerPromises: Promise<void>[] = [];
      const freeProfiles = [...availableProfiles];

      // Mark profiles as busy
      for (const p of availableProfiles.slice(0, maxConcurrency)) {
        busyProfilesInSwarms.add(p.id);
      }

      const launchNextTask = async () => {
        if (tasksQueue.length === 0 || execution.abortController.signal.aborted) return;
        const task = tasksQueue.shift()!;
        const profile = freeProfiles.shift()!;
        busyProfilesInSwarms.add(profile.id);

        const installation = snapshot.installations.find((i) => i.tool === profile.tool)!;

        try {
          const workerResult = await runWorker(
            task,
            profile,
            installation,
            options.timeout_seconds,
            execution.abortController.signal,
            (proc) => execution.activeProcesses.add(proc),
            (proc) => execution.activeProcesses.delete(proc),
          );
          execution.workers.push(workerResult);
        } finally {
          freeProfiles.push(profile);
          // Chain next task if queue has more
          if (tasksQueue.length > 0 && !execution.abortController.signal.aborted) {
            await launchNextTask();
          }
        }
      };

      // Launch initial batch
      const initialBatch = Math.min(maxConcurrency, tasksQueue.length);
      for (let i = 0; i < initialBatch; i++) {
        workerPromises.push(launchNextTask());
      }

      await Promise.all(workerPromises);

      const completedCount = execution.workers.filter((w) => w.status === 'completed').length;
      const failedCount = execution.workers.filter((w) => w.status === 'failed' || w.status === 'timeout').length;

      let finalStatus: SwarmResult['status'] = 'completed';
      if (failedCount > 0 && completedCount > 0) finalStatus = 'partial';
      else if (failedCount > 0 && completedCount === 0) finalStatus = 'failed';

      const completedAt = new Date().toISOString();
      execution.status = finalStatus;
      execution.completedAt = completedAt;

      const summary = `Swarm ${swarmId} finished with status '${finalStatus}': ${completedCount}/${execution.workers.length} tasks completed successfully.`;

      return {
        swarmId,
        provider: options.provider,
        status: finalStatus,
        startedAt,
        completedAt,
        workers: execution.workers,
        summary,
      };
    } finally {
      for (const p of availableProfiles) {
        busyProfilesInSwarms.delete(p.id);
      }
    }
  };

  execution.promise = runAllWorkers();

  if (options.wait_for_completion) {
    return await execution.promise;
  }

  return {
    swarmId,
    provider: options.provider,
    status: 'running',
    startedAt,
    workers: [],
    summary: `Swarm ${swarmId} dispatched asynchronously with ${options.tasks.length} tasks across ${availableProfiles.length} profiles.`,
  };
}

export function getSwarmStatus(swarmId: string): SwarmResult | undefined {
  const execution = activeSwarms.get(swarmId);
  if (!execution) return undefined;

  const completedCount = execution.workers.filter((w) => w.status === 'completed').length;
  return {
    swarmId: execution.swarmId,
    provider: execution.provider,
    status: execution.status,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    workers: [...execution.workers],
    summary:
      execution.status === 'running'
        ? `Swarm ${swarmId} currently running: ${completedCount}/${execution.options.tasks.length} tasks completed so far.`
        : `Swarm ${swarmId} finished: ${completedCount}/${execution.workers.length} tasks completed.`,
  };
}

export async function cancelSwarm(swarmId: string): Promise<boolean> {
  const execution = activeSwarms.get(swarmId);
  if (!execution) return false;

  execution.abortController.abort();
  for (const proc of execution.activeProcesses) {
    proc.kill('SIGTERM');
    setTimeout(() => proc.kill('SIGKILL'), 2000).unref();
  }

  execution.status = 'failed';
  return true;
}
