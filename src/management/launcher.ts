import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { stat } from 'node:fs/promises';
import { attachment, startMultiplexed } from './tmux.js';
import { findExecutable } from './providers.js';
import { isolatedAntigravityLaunch, removeIsolatedRuntime } from './antigravity-isolation.js';
import type { Writable, Readable } from 'node:stream';
import { managementRpc } from './client.js';
import { processIdentity } from './process.js';
import { authenticationConflicts, buildLoginLaunch, buildNativeLaunch } from './providers.js';
import { exec } from '../util.js';
import {
  NativeId,
  Tool,
  normalizeTool,
  type Conversation,
  type Invocation,
  type Profile,
  type SessionEntry,
  type Snapshot,
} from './model.js';

export async function runNative(
  spec: {
    executable: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
    keyringPassword?: Buffer;
    trackNativePid?: boolean;
    cleanup?: () => Promise<void>;
  },
  directory: string,
  registered?: (pid: number, runtimePid?: number) => Promise<void>,
  control?: () => Promise<string | null>,
) {
  const child = spawn(spec.executable, [...spec.args], {
    cwd: directory,
    env: spec.env,
    stdio: spec.trackNativePid ? ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'] : 'inherit',
  });
  const signals = new Map<NodeJS.Signals, () => void>();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) {
    // Terminal SIGINT already reaches both foreground processes. Forward only
    // signals that the terminal does not deliver to the foreground group.
    const handler = () => {
      if (signal !== 'SIGINT') child.kill(signal);
    };
    signals.set(signal, handler);
    process.on(signal, handler);
  }
  const result = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      resolve(code ?? 128 + (signal ? (constants.signals[signal] ?? 1) : 1)),
    );
  });
  // Attach rejection handling immediately, before awaiting registration.
  void result.catch(() => {});
  let timer: ReturnType<typeof setInterval> | undefined;
  let checking = false,
    lastStop: string | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    let nativePid = child.pid;
    if (spec.trackNativePid) {
      (child.stdio[3] as Writable).on('error', () => {});
      (child.stdio[3] as Writable).end(spec.keyringPassword, () => spec.keyringPassword?.fill(0));
      nativePid = await new Promise<number>((resolve, reject) => {
        let body = '';
        const pipe = child.stdio[4] as Readable;
        const timer = setTimeout(
          () => reject(new Error('Isolated Antigravity startup timed out')),
          15_000,
        );
        const finish = (error?: Error, pid?: number) => {
          clearTimeout(timer);
          error ? reject(error) : resolve(pid!);
        };
        pipe.on('error', (error) => finish(error));
        pipe.on('data', (chunk) => {
          body += chunk.toString();
          if (body.length > 128) return finish(new Error('Invalid isolated native process report'));
          if (!body.includes('\n')) return;
          try {
            const pid = JSON.parse(body.trim()).pid;
            if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid native PID');
            finish(undefined, pid);
          } catch {
            finish(new Error('Invalid isolated native process report'));
          }
        });
        pipe.on('end', () => {
          if (!body.includes('\n'))
            finish(new Error('Isolated Antigravity failed before native startup'));
        });
      });
    }
    if (registered && nativePid)
      await registered(nativePid, spec.trackNativePid ? child.pid : undefined);
    if (control)
      timer = setInterval(() => {
        if (checking || child.exitCode !== null || child.signalCode !== null) return;
        checking = true;
        void control()
          .then((requested) => {
            if (
              requested &&
              requested !== lastStop &&
              child.exitCode === null &&
              child.signalCode === null
            ) {
              lastStop = requested;
              child.kill('SIGTERM');
            }
          })
          .catch(() => {})
          .finally(() => {
            checking = false;
          });
      }, 500);
    return await result;
  } catch (error) {
    child.kill('SIGTERM');
    await result.catch(() => {});
    throw error;
  } finally {
    spec.keyringPassword?.fill(0);
    await spec.cleanup?.();
    if (spec.trackNativePid && spec.env.XDG_RUNTIME_DIR)
      await removeIsolatedRuntime(spec.env.XDG_RUNTIME_DIR);
    if (timer) clearInterval(timer);
    for (const [signal, handler] of signals) process.removeListener(signal, handler);
  }
}
export interface LaunchOptions {
  multiplex?: boolean;
  terminal?: Invocation['terminal'];
  profile?: string;
  tool?: Tool;
  directory?: string;
  folder?: string;
  title?: string;
  entryId?: string;
  conversation?: string;
  args?: string[];
  allowAuthEnv?: boolean;
}
export async function launchMultipleAgents(
  profiles: string[],
  baseOptions: LaunchOptions = {},
): Promise<number> {
  const cleanProfiles = profiles
    .flatMap((p) => p.split(','))
    .map((p) => p.trim())
    .filter(Boolean);

  if (!cleanProfiles.length) {
    throw new Error('Specify at least one profile to launch.');
  }
  if (cleanProfiles.length === 1) {
    return launchAgent({ ...baseOptions, profile: cleanProfiles[0] });
  }

  await managementRpc('installations.refresh');
  const snapshot: Snapshot = await managementRpc('snapshot');
  const resolvedProfiles: Profile[] = [];

  for (const ref of cleanProfiles) {
    const normalized = normalizeTool(ref);
    let targetProfile: Profile | undefined;
    if (normalized || (Tool.options as readonly string[]).includes(ref)) {
      const tool = normalized ?? (ref as Tool);
      const activeId = snapshot.activeProfiles?.[tool];
      targetProfile =
        (activeId ? snapshot.profiles.find((p) => p.id === activeId) : undefined) ??
        snapshot.profiles.find((p) => p.tool === tool);
    } else {
      targetProfile = snapshot.profiles.find((p) => p.id === ref || p.label === ref);
    }
    if (!targetProfile) {
      throw new Error(`Profile '${ref}' not found. Check /profiles for available accounts.`);
    }
    resolvedProfiles.push(targetProfile);
  }

  const binary = await findExecutable('tmux');
  const persistent =
    baseOptions.multiplex ??
    (process.stdin.isTTY &&
      process.stdout.isTTY &&
      !process.env.TMUX &&
      process.env.PRINCIPAL_NATIVE_DIRECT !== '1' &&
      !!binary);

  if (persistent && binary) {
    const results: { profile: Profile; id: string; terminal: Invocation['terminal'] }[] = [];
    for (const prof of resolvedProfiles) {
      const result = await startMultiplexed({
        ...baseOptions,
        profile: prof.id,
        title: prof.label,
        multiplex: true,
      });
      results.push({ profile: prof, id: result.id, terminal: result.terminal });
    }

    const primary = results[0];
    if (primary.terminal && primary.terminal.socket && primary.terminal.session) {
      for (let i = 1; i < results.length; i++) {
        const item = results[i];
        if (item.terminal && item.terminal.session) {
          try {
            await exec(
              binary,
              [
                '-S',
                primary.terminal.socket,
                'link-window',
                '-s',
                `${item.terminal.session}:0`,
                '-t',
                `${primary.terminal.session}:${i}`,
                '-k',
              ],
              { timeout: 3000, allowFailure: true },
            );
          } catch {
            // Keep running if window link encountered an edge case
          }
        }
      }
      try {
        await exec(
          binary,
          ['-S', primary.terminal.socket, 'select-window', '-t', `${primary.terminal.session}:0`],
          { timeout: 2000, allowFailure: true },
        );
      } catch {}
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return 0;
    }

    return attachInvocation(primary.id);
  }

  // Fallback for non-tmux or direct sequential run
  let lastCode = 0;
  for (const prof of resolvedProfiles) {
    lastCode = await launchAgent({ ...baseOptions, profile: prof.id });
  }
  return lastCode;
}

export async function launchAgent(options: LaunchOptions, preparedCallback?: (id: string) => void) {
  if (options.profile && options.profile.includes(',')) {
    return launchMultipleAgents(options.profile.split(','), options);
  }
  const normalized = options.profile ? normalizeTool(options.profile) : null;
  if (!options.profile || normalized || (Tool.options as readonly string[]).includes(options.profile)) {
    const snapshot: Snapshot = await managementRpc('snapshot');
    const tool =
      normalized ??
      (options.profile && (Tool.options as readonly string[]).includes(options.profile)
        ? (options.profile as Tool)
        : (options.tool ?? 'antigravity'));
    const activeId = snapshot.activeProfiles?.[tool];
    const resolved = (activeId && snapshot.profiles.find((p) => p.id === activeId)) ??
      snapshot.profiles.find((p) => p.tool === tool);
    if (!resolved) {
      throw new Error(`No available profile found for ${tool}. Use /swap or /profiles to add one.`);
    }
    options = { ...options, profile: resolved.id };
  }
  const persistent =
    options.multiplex ??
    (process.stdin.isTTY &&
      process.stdout.isTTY &&
      !process.env.TMUX &&
      process.env.PRINCIPAL_NATIVE_DIRECT !== '1' &&
      !!(await findExecutable('tmux')));
  if (persistent) {
    const result = await startMultiplexed(options);
    if (!process.stdin.isTTY || !process.stdout.isTTY) return 0;
    return attachInvocation(result.id);
  }
  await managementRpc('installations.refresh');
  const snapshot: Snapshot = await managementRpc('snapshot');
  const profile = snapshot.profiles.find(
    (p) => p.id === options.profile || p.label === options.profile,
  );
  if (!profile) throw new Error('Unknown profile');
  const conflicts = authenticationConflicts(profile);
  if (conflicts.length && !options.allowAuthEnv)
    throw new Error(
      `Authentication environment conflicts: ${conflicts.join(', ')}. Explicitly use --allow-auth-env to retain overrides`,
    );
  const installation = snapshot.installations.find((i) => i.tool === profile.tool)!;
  const conversation = options.conversation ? NativeId.parse(options.conversation) : undefined;
  const spec = buildNativeLaunch(profile, installation, options.args ?? [], conversation);
  const wrapper = await processIdentity(process.pid);
  if (!wrapper) throw new Error('Cannot establish launch wrapper identity');
  const prepared = await managementRpc('launch.prepare', {
    profile: profile.id,
    directory: options.directory ?? process.cwd(),
    folder: options.folder ?? 'unassigned',
    title: options.title,
    entryId: options.entryId,
    conversation,
    wrapper,
    allowAuthEnv: !!options.allowAuthEnv,
    terminal: options.terminal,
  });
  preparedCallback?.(prepared.invocation.id);
  spec.env.PRINCIPAL_INVOCATION_ID = prepared.invocation.id;
  let exitCode: number | null = null;
  try {
    const launchSpec =
      profile.tool === 'antigravity' && profile.isolated
        ? await isolatedAntigravityLaunch(profile, spec)
        : spec;
    exitCode = await runNative(
      launchSpec,
      options.directory ?? process.cwd(),
      async (pid, runtimePid) => {
        try {
          const identity = await processIdentity(pid);
          if (!identity) return; // A very short-lived CLI can exit before registration.
          const runtimeIdentity = runtimePid ? await processIdentity(runtimePid) : undefined;
          await managementRpc('launch.register', {
            id: prepared.invocation.id,
            identity,
            runtimeIdentity,
          });
        } catch {
          console.error(
            'Principal could not register this process; native work continues with incomplete management visibility.',
          );
        }
      },
      async () =>
        (await managementRpc('invocations.control', { id: prepared.invocation.id, wrapper }))
          .stopRequestedAt,
    );
    return exitCode;
  } finally {
    try {
      await managementRpc('launch.exit', { id: prepared.invocation.id, exitCode });
    } catch {
      console.error(
        'Principal could not record exit; management will reconcile without replaying work.',
      );
    }
  }
}
export async function resumeEntry(id: string, experimentalHistory = false) {
  const snapshot: Snapshot = await managementRpc('snapshot');
  const entry = snapshot.entries.find((e) => e.id === id);
  if (!entry?.profileId)
    throw new Error('This entry has no confirmed launch profile; resume through the native CLI');
  const project = snapshot.projects.find((p) => p.id === entry.projectId)!;
  const conversation = snapshot.conversations.find((c) => c.id === entry.conversationId);
  if (conversation?.nativeResumeVerified === false && !experimentalHistory)
    throw new Error(
      'Cross-account Antigravity history continuation is unverified. Use /sessions and Shift+R to review the experimental resume warning.',
    );
  const installation = snapshot.installations.find((i) => i.tool === entry.tool)!;
  if (!installation.capabilities.resume.supported)
    throw new Error(installation.capabilities.resume.reason);
  if (!conversation && entry.tool === 'antigravity')
    throw new Error('No native conversation ID observed; use agy --continue directly');
  if (entry.tool === 'antigravity') {
    const exists = await stat(project.directory).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!exists)
      throw new Error(
        'History is stored, but its original workspace no longer exists. Restore that directory before native Antigravity resume; opaque workspace paths are not remapped automatically.',
      );
  }
  const args = !conversation ? (entry.tool === 'codex' ? ['resume'] : ['--resume']) : [];
  return launchAgent({
    profile: entry.profileId,
    directory: project.directory,
    folder: entry.folderId,
    entryId: entry.id,
    conversation: conversation?.nativeId,
    args,
  });
}
export async function loginProfile(reference: string, deviceAuth = false) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Native authentication requires an interactive terminal');
  await managementRpc('installations.refresh');
  const snapshot: Snapshot = await managementRpc('snapshot');
  const profile = snapshot.profiles.find((p) => p.id === reference || p.label === reference);
  if (!profile) throw new Error('Unknown profile');
  if (snapshot.invocations.some((i) => i.profileId === profile.id && i.lifecycle !== 'exited'))
    throw new Error('Finish this profile’s managed invocations before changing authentication');
  const conflicts = authenticationConflicts(profile);
  if (conflicts.length)
    throw new Error(
      `Resolve authentication environment conflicts before login: ${conflicts.join(', ')}`,
    );
  const installation = snapshot.installations.find((i) => i.tool === profile.tool)!;
  await stat(profile.directory).catch(() => {
    throw new Error(
      'Native configuration directory is missing; launch the tool once or add an isolated profile',
    );
  });
  const spec = buildLoginLaunch(profile, installation, deviceAuth);
  await managementRpc('profiles.login.prepare', { profile: profile.id });
  // Antigravity authenticates inside its full TUI. Track that process exactly
  // like a native launch so its statusline can identify the selected profile.
  if (profile.tool === 'antigravity')
    return launchAgent({
      profile: profile.id,
      directory: profile.directory,
      title: 'Antigravity sign-in',
    });
  // Native tools own login and refresh. Principal never reads credential files.
  const code = await runNative(spec, profile.directory);
  try {
    await managementRpc('profiles.inspect', { profile: profile.id });
  } catch {
    console.error('Native login completed; authentication status remains unverified.');
  }
  return code;
}
export function latestInvocation(entry: SessionEntry, invocations: Invocation[]) {
  return invocations
    .filter((i) => i.entryId === entry.id)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}
export function conversationFor(entry: SessionEntry, conversations: Conversation[]) {
  return conversations.find((c) => c.id === entry.conversationId);
}
export function profileFor(entry: SessionEntry, profiles: Profile[]) {
  return profiles.find((p) => p.id === entry.profileId);
}

/** Restart native UI from persisted history; never move or attach an existing process. */
export async function reopenEntry(
  id: string,
  stopInvocationId?: string | null,
  experimentalHistory = false,
  forceStop = false,
) {
  let plan = await managementRpc('entries.reopen', { entry: id });
  if (plan.mode === 'attach') return attachInvocation(plan.invocationId);
  if (plan.experimentalHistory && !experimentalHistory)
    throw new Error('Review the experimental Antigravity continuation warning before reopening.');
  if (plan.stopInvocationId) {
    if (plan.stopInvocationId !== stopInvocationId)
      throw new Error('The active invocation changed; review Reopen on this terminal again.');
    await managementRpc('invocations.stop', { id: stopInvocationId, force: forceStop });
    console.log('Waiting for the original agent to exit before reopening…');
  }
  const deadline = Date.now() + 30_000;
  while (plan.stopInvocationId || plan.waitingForExit) {
    if (Date.now() >= deadline)
      throw new Error(
        'The agent did not exit after the graceful stop. Reopen its action again to choose Force stop and reopen. No second process was launched.',
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
    plan = await managementRpc('entries.reopen', { entry: id });
    if (plan.mode === 'attach')
      throw new Error(
        'A persistent invocation appeared while waiting; review Jump to current run again.',
      );
    if (plan.stopInvocationId && plan.stopInvocationId !== stopInvocationId)
      throw new Error('Another invocation started; reopen refused.');
  }
  if (!['latest', 'native'].includes(plan.mode)) return resumeEntry(id, experimentalHistory);
  const snapshot: Snapshot = await managementRpc('snapshot');
  const entry = snapshot.entries.find((e) => e.id === id)!;
  const project = snapshot.projects.find((p) => p.id === entry.projectId)!;
  return launchAgent({
    profile: entry.profileId!,
    entryId: entry.id,
    folder: entry.folderId,
    directory: project.directory,
    args: plan.mode === 'latest' ? ['--continue'] : [],
  });
}
export async function attachInvocation(id: string) {
  const snapshot: Snapshot = await managementRpc('snapshot');
  const invocation = snapshot.invocations.find((i) => i.id === id);
  const spec = invocation && (await attachment(invocation));
  if (!spec)
    throw new Error('Persistent terminal is unavailable or ownership changed. Inspect /sessions.');
  console.log('Attaching to the running agent. Ctrl+b, then d detaches back to Principal.');
  return runNative(spec, process.cwd());
}
