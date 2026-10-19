import { nativeStatuslineCommand } from './statusline-command.js';
import { credentialExpiry, isolationHealth, type DiagnosticsReport } from './diagnostics.js';
import { attachment, tmuxSocket } from './tmux.js';
import { compatiblePatch } from './compatibility.js';
import {
  antigravityHistory,
  copyAntigravityConversation,
  localConversationAvailable,
} from './antigravity-history.js';
import { copilotAuth, copilotQuota } from './copilot.js';
import { probeAntigravity } from './antigravity-probe.js';
import { evaluateQuotaAlerts, dispatchAlert } from './alerts.js';
import { realpath, stat, writeFile, mkdir, readFile, lstat, unlink, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { ManagementStore } from './store.js';
import {
  Callback,
  Identifier,
  Label,
  parseProfileLabel,
  NativeId,
  Tool,
  normalizeTool,
  type Conversation,
  type Installation,
  type Invocation,
  type Profile,
  type SessionEntry,
  type Snapshot,
  type Project,
} from './model.js';
import { defaultDirectory, detectInstallations, authenticationConflicts, findExecutable } from './providers.js';
import {
  ancestors,
  controllingTerminal,
  discoverProcesses,
  identifyTool,
  identityMatches,
  processIdentity,
  forceStopOwned,
} from './process.js';
import { managementPaths, privateDirectory } from './paths.js';
import { codexRead, CodexRpcError } from './codex.js';
import { copyCodexConversation } from './history-copy.js';
import { normalizeCodexLimits } from './observations.js';
import { exec } from '../util.js';
import { profileEnvironment } from './providers.js';
import { ensureSharedHistory } from './shared-history.js';
import {
  locateCodexRollout,
  readRolloutRecords,
  parseCodexRollout,
  synthesizeContextHandoff,
  saveHandoffDocument,
  copyToClipboard,
} from './context-export.js';
import {
  createHandoffBundle,
  parseAndValidateBundle,
  parseDurationToHours,
  copyToClipboard as copyHandoffClipboard,
} from './account-handoff.js';

const at = () => new Date().toISOString();
const FolderName = Label.refine((name) => !name.includes('/'), 'Folder names cannot include /');
const Identity = z.object({
  pid: z.number().int().positive(),
  startTime: z.string(),
  bootId: z.string(),
});
const profileInput = z.object({
  tool: z.preprocess((v) => (typeof v === 'string' ? normalizeTool(v) ?? v : v), Tool),
  label: Label,
  directory: z.string().max(4096).optional(),
  isolated: z.boolean().default(false),
  sharedHistory: z.boolean().default(true),
  discovery: z.boolean().default(false),
  handoff: z.boolean().default(false),
});
export class ManagementService {
  installations: Installation[] = [];
  private readonly probes = new Map<string, Promise<unknown>>();
  private readonly inspections = new Map<string, Promise<{ profile: Profile; reason?: string }>>();
  private readonly historyCopies = new Set<string>();
  private readonly failures = new Map<string, { count: number; next: number }>();
  private readonly alertHistory = new Set<string>();
  private readonly previousQuota = new Map<string, number>();
  private ticking = false;
  private lastDiscovery = 0;
  private lastRefresh = 0;
  private lastPruned = 0;
  private resourceRefresh?: Promise<Awaited<ReturnType<ManagementService['collectResources']>>>;
  private lastInstallationCheck = Date.now();
  constructor(
    readonly store: ManagementStore,
    readonly environment: Snapshot['environment'],
  ) {}
  async initialize() {
    this.installations = await detectInstallations();
    try {
      this.store.prune();
    } catch {}
    for (const p of this.store.profiles()) {
      const inst = this.installations.find((i) => i.tool === p.tool);
      if (p.isolated && (p.sharedHistory ?? true)) {
        await ensureSharedHistory(p, inst).catch(() => {});
      }
    }
    await this.tick();
  }
  installation(tool: Tool) {
    const installation = this.installations.find((i) => i.tool === tool);
    if (!installation) throw new Error('Tool discovery has not completed');
    return installation;
  }
  snapshot(): Snapshot {
    return {
      protocolVersion: 1,
      seq: this.store.seq,
      environment: this.environment,
      installations: this.installations,
      profiles: this.store.profiles(),
      activeProfiles: this.store.activeProfiles(),
      dismissedAccountIds: this.store.dismissedAccountIds(),
      excludedProfiles: this.store
        .list<Profile>('profile')
        .filter((p) => p.removedAt)
        .map((p) => ({ tool: p.tool, directory: p.directory })),
      folders: this.store.list('folder'),
      projects: this.store.list('project'),
      entries: this.store.list('entry'),
      invocations: this.store.list('invocation'),
      conversations: this.store.list('conversation'),
      bindings: this.store.list('binding'),
      resources: this.store.resources(),
      ui: this.store.ui(),
    };
  }
  async addProfile(raw: unknown) {
    if (raw && typeof raw === 'object') parseProfileLabel((raw as Record<string, unknown>).label);
    const input = profileInput.parse(raw);
    const installation = this.installation(input.tool);
    if (
      input.isolated &&
      !input.handoff &&
      !installation.capabilities.configurationIsolation.supported
    )
      throw new Error(installation.capabilities.configurationIsolation.reason);
    if (input.isolated && input.directory)
      throw new Error('Choose --isolated or an existing --directory');
    if (this.store.profiles().some((p) => p.label === input.label))
      throw new Error('Choose a unique profile label');
    const id = randomUUID();
    let directory = input.isolated
      ? path.join(managementPaths.profiles, id)
      : path.resolve(input.directory ?? defaultDirectory(input.tool));
    if (
      !input.isolated &&
      input.directory &&
      (!installation.capabilities.configurationIsolation.supported ||
        input.tool === 'antigravity') &&
      directory !== defaultDirectory(input.tool)
    )
      throw new Error('This tool has no validated profile directory selector');
    if (input.isolated) {
      await privateDirectory(directory);
      if (input.tool === 'antigravity') {
        directory = path.join(directory, '.gemini', 'antigravity-cli');
        await privateDirectory(directory);
        await writeFile(
          path.join(directory, 'settings.json'),
          JSON.stringify(
            {
              statusLine: { type: 'command', command: nativeStatuslineCommand('antigravity') },
            },
            null,
            2,
          ) + '\n',
          { mode: 0o600, flag: 'wx' },
        );
      }
    } else {
      try {
        directory = await realpath(directory);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        if (input.directory)
          throw new Error('Existing native configuration directory does not exist');
        await privateDirectory(directory);
      }
    }
    const metadata = await stat(directory);
    if (!metadata.isDirectory() || metadata.uid !== process.getuid?.())
      throw new Error('Native configuration must be a directory owned by this user');
    const profiles = this.store.profiles();
    if (profiles.some((p) => p.label === input.label))
      throw new Error('Choose a unique profile label');
    if (profiles.some((p) => p.tool === input.tool && p.directory === directory))
      throw new Error(
        'This native configuration is already registered; aliases do not isolate accounts',
      );
    const removed = this.store
      .list<Profile>('profile')
      .find((p) => p.removedAt && p.tool === input.tool && p.directory === directory);
    if (removed && input.discovery) return null;
    const profile = this.store.put<Profile>('profile', {
      id: removed?.id ?? id,
      tool: input.tool,
      label: input.label,
      directory,
      isolated: input.isolated,
      sharedHistory: input.sharedHistory,
      createdAt: removed?.createdAt ?? at(),
      auth: 'unknown',
      authObservedAt: null,
      reportedAccount: null,
      plan: null,
    });
    if (input.isolated && (input.sharedHistory ?? true)) {
      await ensureSharedHistory(profile, installation).catch(() => {});
    }
    this.failures.delete(profile.id);
    this.store.event(removed ? 'profile.restored' : 'profile.created', profile.id);
    return profile;
  }
  renameProfile(reference: string, value: unknown) {
    const label = parseProfileLabel(value);
    const profile = this.store.profile(reference);
    if (this.store.profiles().some((p) => p.id !== profile.id && p.label === label))
      throw new Error('Choose a unique profile label');
    const updated = this.store.put('profile', { ...profile, label });
    this.store.event('profile.renamed', profile.id);
    return updated;
  }
  removeProfile(reference: string) {
    const profile = this.store.profile(reference);
    if (this.historyCopies.has(profile.id))
      throw new Error('Finish the conversation copy before removing this profile.');
    if (
      this.store
        .list<Invocation>('invocation')
        .some((i) => i.profileId === profile.id && i.lifecycle !== 'exited')
    )
      throw new Error('Finish active or uncertain sessions before removing this profile.');
    if (this.probes.has(profile.id))
      throw new Error('Wait for the usage refresh to finish before removing this profile.');
    this.store.put('profile', { ...profile, removedAt: at() });
    this.store.event('profile.removed', profile.id);
    return { removed: profile.id, credentialsPreserved: true, historyPreserved: true };
  }
  profileHeadroom(profileId: string): number | undefined {
    const resources = this.store.resources().filter((r) => r.profileId === profileId);
    if (!resources.length) return undefined;
    const weeklyGemini = resources.find(
      (r) => r.bucket === 'gemini-weekly' && r.metric === 'quota-remaining',
    );
    if (weeklyGemini !== undefined) return weeklyGemini.value;
    const weekly3p = resources.find(
      (r) => r.bucket === '3p-weekly' && r.metric === 'quota-remaining',
    );
    if (weekly3p !== undefined) return weekly3p.value;
    const anyQuotaRemaining = resources.find((r) => r.metric === 'quota-remaining');
    if (anyQuotaRemaining !== undefined) return anyQuotaRemaining.value;

    const codexPrimary = resources.find(
      (r) => r.metric === 'rate-limit-used' && r.bucket.includes('primary'),
    );
    if (codexPrimary !== undefined) return Math.max(0, 100 - codexPrimary.value);
    const anyRateLimitUsed = resources.find((r) => r.metric === 'rate-limit-used');
    if (anyRateLimitUsed !== undefined) return Math.max(0, 100 - anyRateLimitUsed.value);

    return undefined;
  }
  rankProfilesForTool(tool: Tool): Array<{ profile: Profile; headroom?: number }> {
    const toolProfiles = this.store.profiles().filter((p) => p.tool === tool);
    const scored = toolProfiles.map((profile) => ({
      profile,
      headroom: this.profileHeadroom(profile.id),
    }));

    return scored.sort((a, b) => {
      const aAuth = a.profile.auth === 'authenticated' ? 1 : 0;
      const bAuth = b.profile.auth === 'authenticated' ? 1 : 0;
      if (aAuth !== bAuth) return bAuth - aAuth;

      const aHeadroom = a.headroom ?? -1;
      const bHeadroom = b.headroom ?? -1;
      if (aHeadroom !== bHeadroom) return bHeadroom - aHeadroom;

      return a.profile.label.localeCompare(b.profile.label);
    });
  }
  async syncAntigravityAmbient(
    profile: Profile,
  ): Promise<{ tool: Tool; attempted: boolean; synced: boolean; message?: string }> {
    if (!profile.reportedAccount) {
      return {
        tool: 'antigravity',
        attempted: false,
        synced: false,
        message: 'Profile has no reported account email',
      };
    }
    try {
      const agyRotate = await findExecutable('agy-rotate');
      if (!agyRotate) {
        return {
          tool: 'antigravity',
          attempted: false,
          synced: false,
          message: 'agy-rotate utility not found',
        };
      }
      const listProc = await exec(agyRotate, ['list'], { allowFailure: true });
      if (listProc.code !== 0) {
        return {
          tool: 'antigravity',
          attempted: true,
          synced: false,
          message: 'agy-rotate list failed',
        };
      }
      let matchedName: string | undefined;
      for (const line of listProc.stdout.toString().split('\n')) {
        const match = line.match(/^([^:]+):\s*(.+)$/);
        if (match && match[2].trim().toLowerCase() === profile.reportedAccount.toLowerCase()) {
          matchedName = match[1].trim();
          break;
        }
      }
      if (!matchedName) {
        return {
          tool: 'antigravity',
          attempted: true,
          synced: false,
          message: `No agy-rotate profile for ${profile.reportedAccount}`,
        };
      }
      const switchProc = await exec(agyRotate, ['switch', '--no-usage', matchedName], {
        allowFailure: true,
      });
      if (switchProc.code === 0) {
        return {
          tool: 'antigravity',
          attempted: true,
          synced: true,
          message: `Switched ambient CLI to ${matchedName} (${profile.reportedAccount})`,
        };
      } else {
        return {
          tool: 'antigravity',
          attempted: true,
          synced: false,
          message: switchProc.stderr.toString().trim() || 'agy-rotate switch failed',
        };
      }
    } catch (error) {
      return {
        tool: 'antigravity',
        attempted: true,
        synced: false,
        message: (error as Error).message,
      };
    }
  }
  private async syncCodexAmbient(profile: Profile): Promise<{
    tool: Tool;
    attempted: boolean;
    synced: boolean;
    message?: string;
  }> {
    try {
      const home = homedir();
      const stateDir = path.join(home, '.local', 'state', 'principal');
      await mkdir(stateDir, { recursive: true });
      await writeFile(path.join(stateDir, 'active_codex_home'), profile.directory, 'utf8');

      const binDir = path.join(home, '.local', 'bin');
      await mkdir(binDir, { recursive: true });
      const wrapperPath = path.join(binDir, 'codex');
      const wrapperContent = `#!/bin/sh
# Principal Ambient Codex Switcher
# Automatically routes to the active Principal Codex profile if CODEX_HOME is not explicitly set.

if [ -z "$CODEX_HOME" ]; then
    ACTIVE_FILE="$HOME/.local/state/principal/active_codex_home"
    if [ -f "$ACTIVE_FILE" ]; then
        ACTIVE_DIR=$(cat "$ACTIVE_FILE" 2>/dev/null)
        if [ -n "$ACTIVE_DIR" ] && [ -d "$ACTIVE_DIR" ]; then
            export CODEX_HOME="$ACTIVE_DIR"
        fi
    fi
fi

REAL_BIN="$HOME/.codex/packages/standalone/current/bin/codex"
if [ ! -x "$REAL_BIN" ]; then
    REAL_BIN="/usr/bin/codex"
fi

exec "$REAL_BIN" "$@"
`;

      let needsInstall = true;
      try {
        const stats = await lstat(wrapperPath);
        if (stats.isSymbolicLink()) {
          await unlink(wrapperPath);
        } else {
          const currentContent = await readFile(wrapperPath, 'utf8');
          if (currentContent === wrapperContent) {
            needsInstall = false;
          }
        }
      } catch {
        // File does not exist yet
      }

      if (needsInstall) {
        await writeFile(wrapperPath, wrapperContent, { mode: 0o755 });
      }

      return {
        tool: 'codex',
        attempted: true,
        synced: true,
        message: `Switched ambient CLI to ${profile.label} (${profile.reportedAccount ?? 'account unknown'})`,
      };
    } catch (error) {
      return {
        tool: 'codex',
        attempted: true,
        synced: false,
        message: (error as Error).message,
      };
    }
  }
  async activeProfilesReport() {
    const activeMap = this.store.activeProfiles();
    const allProfiles = this.store.profiles();

    const report: Record<
      string,
      {
        active: { profile: Profile; remainingHeadroom?: number } | null;
        profiles: Array<{ profile: Profile; remainingHeadroom?: number; isActive: boolean }>;
      }
    > = {};

    for (const tool of Tool.options) {
      const toolProfiles = allProfiles.filter((p) => p.tool === tool);
      if (!toolProfiles.length) continue;

      const activeId = activeMap[tool] ?? toolProfiles[0]?.id;
      const ranked = this.rankProfilesForTool(tool);

      const activeProfile = toolProfiles.find((p) => p.id === activeId) ?? null;
      const activeHeadroom = activeProfile ? this.profileHeadroom(activeProfile.id) : undefined;

      report[tool] = {
        active: activeProfile ? { profile: activeProfile, remainingHeadroom: activeHeadroom } : null,
        profiles: ranked.map((r) => ({
          profile: r.profile,
          remainingHeadroom: r.headroom,
          isActive: r.profile.id === activeId,
        })),
      };
    }
    return report;
  }
  async swapProfile(raw: unknown) {
    const input = z
      .object({
        tool: z.preprocess((v) => (typeof v === 'string' ? normalizeTool(v) ?? v : v), Tool.optional()),
        target: z.string().optional(),
        best: z.boolean().optional(),
      })
      .parse(raw);

    const profiles = this.store.profiles();
    let targetProfile: Profile | undefined;
    let tool = input.tool;

    if (input.target) {
      targetProfile = profiles.find(
        (p) =>
          p.id === input.target ||
          p.label === input.target ||
          (p.reportedAccount && p.reportedAccount.toLowerCase() === input.target!.toLowerCase()),
      );
      if (!targetProfile) {
        throw new Error(`Profile '${input.target}' not found`);
      }
      if (tool && targetProfile.tool !== tool) {
        throw new Error(`Profile '${input.target}' belongs to ${targetProfile.tool}, not ${tool}`);
      }
      tool = targetProfile.tool;
    } else {
      if (!tool) {
        const toolSet = new Set(profiles.map((p) => p.tool));
        if (toolSet.size === 1) {
          tool = [...toolSet][0];
        } else {
          throw new Error('Specify a provider (antigravity or codex) or target profile to swap');
        }
      }
      const ranked = this.rankProfilesForTool(tool);
      if (!ranked.length) {
        throw new Error(`No profiles found for ${tool}`);
      }
      targetProfile = ranked[0].profile;
    }

    const previousId = this.store.activeProfiles()[tool] ?? null;
    this.store.setActiveProfile(tool, targetProfile.id);

    let ambientSync:
      | { tool: Tool; attempted: boolean; synced: boolean; message?: string }
      | undefined;
    if (tool === 'antigravity') {
      ambientSync = await this.syncAntigravityAmbient(targetProfile);
    } else if (tool === 'codex') {
      ambientSync = await this.syncCodexAmbient(targetProfile);
    }

    return {
      swapped: true,
      tool,
      previousId,
      current: targetProfile,
      ambientSync,
    };
  }
  async prepare(raw: unknown) {
    const input = z
      .object({
        profile: Identifier,
        directory: z.string().max(4096),
        folder: Identifier.default('unassigned'),
        title: Label.optional(),
        entryId: z.string().uuid().optional(),
        wrapper: Identity,
        conversation: NativeId.optional(),
        allowAuthEnv: z.boolean().default(false),
        terminal: z
          .object({
            kind: z.literal('tmux'),
            socket: z.string().refine((value) => value === tmuxSocket()),
            session: z.string().regex(/^principal-[a-f0-9-]{36}$/),
          })
          .optional(),
      })
      .parse(raw);
    const profile = this.store.profile(input.profile);
    if (!this.installation(profile.tool).executable) throw new Error(`Install ${profile.tool}`);
    if (profile.handoffConstraints) {
      const { expiresAt, timeLimitHours, allowedQuotaFloor, quotaLimitPercent } =
        profile.handoffConstraints;
      if (expiresAt && Date.now() >= Date.parse(expiresAt)) {
        await this.purgeHandoffProfile(
          profile,
          'time-expired',
          `Handoff time limit (${timeLimitHours ?? 'N'}h) expired at ${new Date(expiresAt).toLocaleString()}`,
        );
        throw new Error(
          `Account handoff expired and was purged: time limit (${timeLimitHours ?? 'N'}h) ended at ${new Date(expiresAt).toLocaleString()}`,
        );
      }
      if (allowedQuotaFloor !== undefined) {
        const currentHeadroom = this.profileHeadroom(profile.id);
        if (currentHeadroom !== undefined && currentHeadroom <= allowedQuotaFloor) {
          await this.purgeHandoffProfile(
            profile,
            'quota-exhausted',
            `Handoff quota budget (${quotaLimitPercent}%) exhausted (remaining: ${currentHeadroom.toFixed(1)}%, floor: ${allowedQuotaFloor.toFixed(1)}%)`,
          );
          throw new Error(
            `Account handoff quota limit reached and was purged: owner allocated ${quotaLimitPercent}% of weekly quota (remaining: ${currentHeadroom.toFixed(1)}%, limit floor: ${allowedQuotaFloor.toFixed(1)}%)`,
          );
        }
      }
    }
    // The foreground launcher validates its own environment. The daemon's
    // startup environment may differ and cannot prove a launch's account.
    if (!(await identityMatches(input.wrapper)))
      throw new Error('Launch wrapper identity is no longer valid');
    const directory = await realpath(input.directory);
    if (!(await stat(directory)).isDirectory()) throw new Error('Choose a project directory');
    const folder = this.store.folder(input.folder);
    const project = this.store.project(directory, this.environment.id);
    return this.store.db.transaction(() => {
      if (
        profile.tool === 'antigravity' &&
        profile.isolated &&
        this.store
          .list<Invocation>('invocation')
          .some((i) => i.profileId === profile.id && i.lifecycle !== 'exited')
      )
        throw new Error(
          'This isolated Antigravity profile is already active. Use a different profile for parallel work; each private keyring has one writer.',
        );
      if (this.historyCopies.has(profile.id))
        throw new Error('Wait for the conversation copy to finish before launching this profile');
      const existing = input.entryId
        ? this.store.require<SessionEntry>('entry', input.entryId)
        : null;
      if (existing && (existing.profileId !== profile.id || existing.projectId !== project.id))
        throw new Error('Resume requires the original profile and project');
      if (
        existing &&
        this.store
          .list<Invocation>('invocation')
          .some((i) => i.entryId === existing.id && i.lifecycle !== 'exited')
      )
        throw new Error(
          'This entry has an active or uncertain invocation; inspect it before resuming',
        );
      const entry =
        existing ??
        this.store.put<SessionEntry>('entry', {
          id: randomUUID(),
          profileId: profile.id,
          tool: profile.tool,
          folderId: folder.id,
          projectId: project.id,
          title: input.title ?? `${profile.tool} · ${project.name}`,
          createdAt: at(),
          archivedAt: null,
          conversationId: null,
        });
      if (existing?.archivedAt) this.store.updateEntry(existing.id, { archivedAt: null });
      const invocation = this.store.put<Invocation>('invocation', {
        id: randomUUID(),
        entryId: entry.id,
        profileId: profile.id,
        owned: true,
        wrapper: input.wrapper,
        terminal: input.terminal,
        identity: null,
        startedAt: at(),
        endedAt: null,
        lifecycle: 'starting',
        activity: 'unknown',
        connection: 'connected',
        observedAt: at(),
        exitCode: null,
        reportedAccount: null,
      });
      if (input.conversation) this.store.bind(invocation, input.conversation, 'launch-request');
      this.store.event('invocation.prepared', invocation.id);
      return { entry, invocation, profile, installation: this.installation(profile.tool) };
    })();
  }
  async registered(raw: unknown) {
    const input = z
      .object({ id: z.string().uuid(), identity: Identity, runtimeIdentity: Identity.optional() })
      .parse(raw);
    const invocation = this.store.require<Invocation>('invocation', input.id);
    if (
      !invocation.owned ||
      invocation.lifecycle === 'exited' ||
      !(await identityMatches(input.identity))
    )
      throw new Error('Cannot register an unowned or exited process');
    if (
      !invocation.wrapper ||
      !(await ancestors(input.identity.pid)).includes(invocation.wrapper.pid) ||
      !(await identityMatches(invocation.wrapper))
    )
      throw new Error('Native process must descend from the registered wrapper');
    if (
      input.runtimeIdentity &&
      (!(await identityMatches(input.runtimeIdentity)) ||
        !(await ancestors(input.identity.pid)).includes(input.runtimeIdentity.pid) ||
        !(await ancestors(input.runtimeIdentity.pid)).includes(invocation.wrapper.pid))
    )
      throw new Error('Isolated runtime must be an owned ancestor of the native agent');
    const updated = this.store.updateInvocation(invocation.id, {
      ...(input.runtimeIdentity ? { runtimeIdentity: input.runtimeIdentity } : {}),
      identity: input.identity,
      lifecycle: 'running',
      observedAt: at(),
    });
    this.store.event('invocation.started', invocation.id);
    return updated;
  }
  async observe(raw: unknown) {
    const input = Callback.parse(raw);
    if (!this.installation(input.tool).capabilities.observer.supported)
      throw new Error('Observation parser is disabled for this tool version');
    let invocation = input.invocationId
      ? this.store.require<Invocation>('invocation', input.invocationId)
      : null;
    if (invocation) {
      const entry = this.store.require<SessionEntry>('entry', invocation.entryId);
      if (
        entry.tool !== input.tool ||
        !invocation.identity ||
        !input.ancestorPids.includes(invocation.identity.pid) ||
        !(await identityMatches(invocation.identity))
      )
        throw new Error('Observation is not associated with the live native process');
    } else {
      for (const pid of input.ancestorPids) {
        if ((await identifyTool(pid, this.installations)) !== input.tool) continue;
        const identity = await processIdentity(pid);
        if (!identity) continue;
        const discovered = await discoverProcesses([this.installation(input.tool)]);
        const match = discovered.find((p) => p.identity.pid === pid);
        if (match) invocation = this.registerExternal(match);
        break;
      }
      if (!invocation) throw new Error('External callback has no verified native process ancestor');
    }
    if (invocation.lifecycle === 'exited')
      throw new Error('Observation arrived after process exit');
    let reportedDirectory: string | undefined;
    if (input.cwd && path.isAbsolute(input.cwd)) {
      try {
        const directory = await realpath(input.cwd);
        if ((await stat(directory)).isDirectory()) reportedDirectory = directory;
      } catch {}
    }
    const updated = this.store.updateInvocation(invocation.id, {
      ...(input.activity
        ? { activity: input.activity, activitySource: input.activitySource ?? null }
        : {}),
      connection: 'connected',
      observedAt: at(),
      ...(input.account ? { reportedAccount: input.account } : {}),
      ...(reportedDirectory ? { reportedDirectory } : {}),
    });
    if (
      input.tool === 'antigravity' &&
      (input.account || input.conversationId || input.resources.length)
    ) {
      const installation = this.installation(input.tool);
      installation.capabilities.observer = {
        supported: true,
        confidence: 'verified-interface',
        reason:
          'Native process callback validated; supported fields are checked independently on every update',
      };
    }
    let targetProfileId = invocation.profileId;
    if (!targetProfileId && input.tool === 'antigravity') {
      const candidate = this.store
        .profiles()
        .find(
          (p) =>
            p.tool === 'antigravity' &&
            Boolean(input.account && p.reportedAccount === input.account),
        );
      if (candidate) targetProfileId = candidate.id;
    }
    if (input.tool === 'antigravity' && targetProfileId) {
      const profile = this.store.require<Profile>('profile', targetProfileId);
      this.store.put('profile', {
        ...profile,
        observationWarnings: input.warnings ?? [],
        ...(input.account
          ? { auth: 'authenticated' as const, authObservedAt: at(), reportedAccount: input.account }
          : {}),
      });
      if (input.account)
        this.store.put('auth-observation', {
          id: `auth:${profile.id}`,
          profileId: profile.id,
          status: 'authenticated',
          account: input.account,
          observedAt: at(),
          source: 'Antigravity native statusline',
        });
    }
    if (input.conversationId) this.store.bind(updated, input.conversationId);
    for (const resource of input.resources) {
      const id = createHash('sha256')
        .update(
          `${targetProfileId ?? 'ext'}:${invocation.id}:${resource.metric}:${resource.bucket}`,
        )
        .digest('hex')
        .slice(0, 24);
      this.store.put('resource', {
        ...resource,
        id,
        profileId: targetProfileId,
        invocationId: invocation.id,
        account: updated.reportedAccount,
        observedAt: at(),
      });
    }
    if (targetProfileId) {
      let prof: Profile | null = null;
      try {
        prof = this.store.profile(targetProfileId);
      } catch {}
      if (prof?.handoffConstraints) {
        const { allowedQuotaFloor, quotaLimitPercent, expiresAt, timeLimitHours } =
          prof.handoffConstraints;
        if (expiresAt && Date.now() >= Date.parse(expiresAt)) {
          void this.stop(invocation.id).catch(() => {});
          await this.purgeHandoffProfile(
            prof,
            'time-expired',
            `Handoff time limit (${timeLimitHours ?? 'N'}h) expired`,
          ).catch(() => {});
        } else if (allowedQuotaFloor !== undefined) {
          const currentHeadroom = this.profileHeadroom(prof.id);
          if (currentHeadroom !== undefined && currentHeadroom <= allowedQuotaFloor) {
            void this.stop(invocation.id).catch(() => {});
            await this.purgeHandoffProfile(
              prof,
              'quota-exhausted',
              `Handoff quota budget (${quotaLimitPercent}%) exhausted (remaining: ${currentHeadroom.toFixed(1)}%, floor: ${allowedQuotaFloor.toFixed(1)}%)`,
            ).catch(() => {});
          }
        }
      }
    }
    this.store.event('invocation.observed', invocation.id);
    return { accepted: true };
  }
  registerExternal(process: {
    identity: NonNullable<Invocation['identity']>;
    tool: Tool;
    directory: string;
  }) {
    const existing = this.store
      .list<Invocation>('invocation')
      .find(
        (i) =>
          i.identity?.pid === process.identity.pid &&
          i.identity.startTime === process.identity.startTime &&
          i.identity.bootId === process.identity.bootId &&
          i.lifecycle !== 'exited',
      );
    if (existing) return existing;
    const project = this.store.project(process.directory, this.environment.id);
    const entry = this.store.put<SessionEntry>('entry', {
      id: randomUUID(),
      folderId: 'unassigned',
      projectId: project.id,
      profileId: null,
      tool: process.tool,
      title: `${process.tool} · external process`,
      createdAt: at(),
      archivedAt: null,
      conversationId: null,
    });
    const invocation = this.store.put<Invocation>('invocation', {
      id: randomUUID(),
      entryId: entry.id,
      profileId: null,
      identity: process.identity,
      wrapper: null,
      owned: false,
      startedAt: at(),
      endedAt: null,
      lifecycle: 'running',
      activity: 'unknown',
      connection: 'connected',
      observedAt: at(),
      exitCode: null,
      reportedAccount: null,
    });
    this.store.event('invocation.discovered', invocation.id);
    return invocation;
  }
  async reopenPlan(raw: unknown) {
    const { entry: id } = z.object({ entry: Identifier }).parse(raw);
    const entry = this.store.require<SessionEntry>('entry', id);
    if (!entry.profileId)
      throw new Error(
        'This is an unassigned process observation, not a saved conversation. Select its account in /profiles and import native history first.',
      );
    const profile = this.store.profile(entry.profileId),
      project = this.store.require<Project>('project', entry.projectId);
    if (project.environmentId !== this.environment.id)
      throw new Error(
        'This session belongs to another environment; its history must be imported locally before reopening.',
      );
    if (
      !(await stat(project.directory).then(
        (s) => s.isDirectory(),
        () => false,
      ))
    )
      throw new Error(
        'The original workspace is missing. Restore it before reopening this conversation.',
      );
    const installation = this.installation(entry.tool);
    for (const invocation of this.store
      .list<Invocation>('invocation')
      .filter((i) => i.entryId === entry.id && i.lifecycle !== 'exited')) {
      if (await attachment(invocation))
        return {
          entry: entry.id,
          mode: 'attach',
          invocationId: invocation.id,
          stopInvocationId: null,
          forceStopAvailable: false,
          waitingForExit: false,
          experimentalHistory: false,
        };
    }
    if (!installation.capabilities.resume.supported)
      throw new Error(installation.capabilities.resume.reason);
    const conversation = entry.conversationId
      ? this.store.require<Conversation>('conversation', entry.conversationId)
      : null;
    let stopInvocationId: string | null = null,
      waitingForExit = false;
    for (const invocation of this.store
      .list<Invocation>('invocation')
      .filter(
        (i) =>
          i.lifecycle !== 'exited' &&
          (i.entryId === entry.id ||
            (profile.tool === 'antigravity' && profile.isolated && i.profileId === profile.id)),
      )) {
      if (invocation.identity && !(await identityMatches(invocation.identity))) {
        if (invocation.runtimeIdentity && (await identityMatches(invocation.runtimeIdentity))) {
          waitingForExit = true;
          continue;
        }
        this.store.finish(invocation, null);
        continue;
      }
      if (invocation.entryId !== entry.id)
        throw new Error(
          'Another conversation is active in this isolated profile. Stop it from its own session row, or choose a different profile.',
        );
      if (!invocation.owned)
        throw new Error(
          'External agents cannot be stopped or moved by Principal; close the native process first.',
        );
      if (
        !invocation.identity ||
        !invocation.wrapper ||
        !(await identityMatches(invocation.wrapper))
      )
        throw new Error(
          'Process ownership is uncertain or the original launcher is unavailable. Reopening is blocked to prevent two writers.',
        );
      if (stopInvocationId)
        throw new Error(
          'Multiple invocations are active; inspect and stop them individually first.',
        );
      const terminal = await controllingTerminal(invocation.identity);
      this.store.updateInvocation(invocation.id, {
        lifecycle: 'running',
        hasControllingTerminal: terminal,
      });
      stopInvocationId = invocation.id;
    }
    return {
      entry: entry.id,
      mode: conversation
        ? 'conversation'
        : entry.tool === 'antigravity'
          ? installation.continueSupported
            ? 'latest'
            : 'native'
          : 'picker',
      stopInvocationId,
      forceStopAvailable:
        !!stopInvocationId &&
        !!this.store.require<Invocation>('invocation', stopInvocationId).stopRequestedAt &&
        Date.now() -
          Date.parse(
            this.store.require<Invocation>('invocation', stopInvocationId).stopRequestedAt!,
          ) >=
          30_000,
      waitingForExit,
      experimentalHistory: conversation
        ? conversation.nativeResumeVerified === false
        : entry.tool === 'antigravity' &&
          this.store
            .list<Conversation>('conversation')
            .some((c) => c.profileId === profile.id && c.nativeResumeVerified === false),
    };
  }
  async stop(id: string, force = false) {
    const invocation = this.store.require<Invocation>('invocation', id);
    if (!invocation.owned || !invocation.identity || invocation.lifecycle !== 'running')
      throw new Error('Only a live Principal-launched invocation can be stopped');
    if (!(await identityMatches(invocation.identity)))
      throw new Error('Process identity changed; stop refused');
    if (!invocation.wrapper || !(await identityMatches(invocation.wrapper)))
      throw new Error('Launch wrapper is unavailable; stop through the native terminal');
    if (force) {
      if (
        !invocation.stopRequestedAt ||
        Date.now() - Date.parse(invocation.stopRequestedAt) < 30_000
      )
        throw new Error('Request a graceful stop and wait 30 seconds before force stopping');
      await forceStopOwned(invocation.identity, invocation.wrapper);
      this.store.event('invocation.force-stop-requested', id);
      return { requested: true, signal: 'SIGKILL', id };
    }
    // The original wrapper signals its ChildProcess handle. Never signal a bare
    // PID from the daemon after a non-atomic identity check.
    this.store.updateInvocation(invocation.id, { stopRequestedAt: at() });
    this.store.event('invocation.stop-requested', id);
    return { requested: true, signal: 'SIGTERM', id };
  }
  async refreshProfile(reference: string, force = false) {
    const profile = this.store.profile(reference);
    const existing = this.probes.get(profile.id);
    if (existing) return existing;
    const installation = this.installation(profile.tool);
    // Push-based observers are not polled by refresh. Their lack of a polling
    // API is not a setup failure, even before the first quota payload arrives.
    if (
      profile.tool === 'claude' &&
      installation.capabilities.observer.supported
    )
      return { profileId: profile.id, refreshed: false, delivery: 'native-callback' };
    if (
      profile.tool === 'antigravity' &&
      (installation.version === 'fixture' ||
        !installation.executable ||
        !installation.capabilities.observer?.supported)
    )
      return { profileId: profile.id, refreshed: false, delivery: 'native-callback' };
    const failure = this.failures.get(profile.id);
    if (failure && failure.next > Date.now())
      return {
        profileId: profile.id,
        refreshed: false,
        reason: profile.observationError?.reason ?? 'Observation backoff is active',
        retryAt: new Date(failure.next).toISOString(),
      };
    if (
      !['codex', 'copilot', 'antigravity'].includes(profile.tool) ||
      (profile.tool !== 'antigravity' && !installation.capabilities.resources.supported)
    )
      return {
        profileId: profile.id,
        refreshed: false,
        reason: installation.capabilities.resources.reason,
      };
    const conflicts = authenticationConflicts(profile);
    if (conflicts.length)
      return {
        profileId: profile.id,
        refreshed: false,
        reason: `Conflicting authentication environment: ${conflicts.join(', ')}`,
      };
    const job = (async () => {
      try {
        if (profile.tool === 'antigravity') {
          if (!force) {
            const latest = this.store
              .resources()
              .filter((r) => r.profileId === profile.id)
              .sort((a, b) => (Date.parse(b.observedAt) || 0) - (Date.parse(a.observedAt) || 0))[0];
            if (latest && Date.now() - (Date.parse(latest.observedAt) || 0) < 15 * 60 * 1000) {
              return { profileId: profile.id, refreshed: true, delivery: 'cached' };
            }
          }
          const probed = await probeAntigravity(profile, installation);
          if (!probed) {
            return { profileId: profile.id, refreshed: false, delivery: 'native-callback' };
          }
          let updated = this.store.require<Profile>('profile', profile.id);
          const resolvedAccount = updated.reportedAccount ?? probed.account ?? null;
          if (resolvedAccount && resolvedAccount !== updated.reportedAccount) {
            updated = {
              ...updated,
              reportedAccount: resolvedAccount,
              auth: 'authenticated',
              authObservedAt: at(),
            };
            this.store.put('profile', updated);
          }
          for (const b of probed.buckets) {
            const id = createHash('sha256')
              .update(`${profile.id}:probe:quota-remaining:${b.bucket}`)
              .digest('hex')
              .slice(0, 24);
            this.store.put('resource', {
              id,
              profileId: profile.id,
              invocationId: null,
              account: updated.reportedAccount,
              metric: 'quota-remaining',
              bucket: b.bucket,
              value: b.value,
              unit: 'percent',
              resetsAt: b.resetsAt,
              source: 'Antigravity native statusline',
              sourceKind: 'official',
              observedAt: at(),
            });
          }
          this.store.event('profile.observed', profile.id);
          this.failures.delete(profile.id);
          if (updated.handoffConstraints) {
            const { allowedQuotaFloor, quotaLimitPercent, expiresAt, timeLimitHours } =
              updated.handoffConstraints;
            if (expiresAt && Date.now() >= Date.parse(expiresAt)) {
              await this.purgeHandoffProfile(
                updated,
                'time-expired',
                `Handoff time limit (${timeLimitHours ?? 'N'}h) expired`,
              );
              return { profileId: profile.id, refreshed: true, purged: true };
            } else if (allowedQuotaFloor !== undefined) {
              const currentHeadroom = this.profileHeadroom(profile.id);
              if (currentHeadroom !== undefined && currentHeadroom <= allowedQuotaFloor) {
                await this.purgeHandoffProfile(
                  updated,
                  'quota-exhausted',
                  `Handoff quota budget (${quotaLimitPercent}%) exhausted (remaining: ${currentHeadroom.toFixed(1)}%, floor: ${allowedQuotaFloor.toFixed(1)}%)`,
                );
                return { profileId: profile.id, refreshed: true, purged: true };
              }
            }
          }
          return { profileId: profile.id, refreshed: true };
        }
        if (profile.tool === 'copilot') {
          const inspected = await this.inspectProfile(profile.id);
          if (inspected.reason || inspected.profile.auth !== 'authenticated')
            throw new Error('Copilot login not verified');
          const quotas = await copilotQuota(profile, installation);
          let count = 0;
          for (const [bucket, quota] of Object.entries(quotas)) {
            const remaining = quota.remainingPercentage;
            if (remaining === undefined || remaining < 0 || remaining > 100) continue;
            this.store.put('resource', {
              id: `copilot:${profile.id}:${bucket}`,
              profileId: profile.id,
              invocationId: null,
              account: inspected.profile.reportedAccount,
              metric: 'quota-remaining',
              bucket,
              value: remaining,
              unit: 'percent',
              resetsAt: quota.resetDate ?? null,
              quota: {
                used: quota.usedRequests,
                allowance: quota.entitlementRequests,
                unlimited: quota.isUnlimitedEntitlement,
              },
              source: 'Copilot SDK account.getQuota',
              sourceKind: 'official',
              observedAt: at(),
            });
            count++;
          }
          if (!count) throw new Error('No supported quota snapshots');
          this.store.event('profile.observed', profile.id);
          this.failures.delete(profile.id);
          return { profileId: profile.id, refreshed: true };
        }
        const [auth, limits] = await codexRead(profile, installation, [
          { method: 'account/read', params: { refreshToken: false } },
          { method: 'account/rateLimits/read', params: {} },
        ]);
        const account = auth?.account;
        const updated: Profile = {
          ...this.store.require<Profile>('profile', profile.id),
          auth: account ? 'authenticated' : 'unauthenticated',
          authObservedAt: at(),
          reportedAccount: typeof account?.email === 'string' ? account.email.slice(0, 160) : null,
          plan: typeof account?.planType === 'string' ? account.planType.slice(0, 160) : null,
          observationError: null,
        };
        this.store.put('profile', updated);
        this.store.put('auth-observation', {
          id: `auth:${profile.id}`,
          profileId: profile.id,
          status: updated.auth,
          account: updated.reportedAccount,
          observedAt: at(),
          source: 'Codex account/read',
        });
        if (updated.reportedAccount) {
          const accountId = createHash('sha256')
            .update(`${profile.tool}:${updated.reportedAccount}`)
            .digest('hex');
          this.store.put('account', {
            id: accountId,
            authority: profile.tool,
            label: updated.reportedAccount,
          });
          if (updated.plan)
            this.store.put('entitlement', {
              id: `entitlement:${accountId}`,
              accountId,
              plan: updated.plan,
              observedAt: at(),
              source: 'Codex account/read',
            });
        }
        for (const resource of normalizeCodexLimits(updated, limits)) {
          const windowPrefix = resource.bucket.split(' ')[0];
          if (windowPrefix) {
            this.store.deleteResourceByBucketPrefix(profile.id, windowPrefix, resource.bucket);
          }
          this.store.put('resource', resource);
        }
        this.store.event('profile.observed', profile.id);
        this.failures.delete(profile.id);
        if (updated.handoffConstraints) {
          const { allowedQuotaFloor, quotaLimitPercent, expiresAt, timeLimitHours } =
            updated.handoffConstraints;
          if (expiresAt && Date.now() >= Date.parse(expiresAt)) {
            await this.purgeHandoffProfile(
              updated,
              'time-expired',
              `Handoff time limit (${timeLimitHours ?? 'N'}h) expired`,
            );
            return { profileId: profile.id, refreshed: true, purged: true };
          } else if (allowedQuotaFloor !== undefined) {
            const currentHeadroom = this.profileHeadroom(profile.id);
            if (currentHeadroom !== undefined && currentHeadroom <= allowedQuotaFloor) {
              await this.purgeHandoffProfile(
                updated,
                'quota-exhausted',
                `Handoff quota budget (${quotaLimitPercent}%) exhausted (remaining: ${currentHeadroom.toFixed(1)}%, floor: ${allowedQuotaFloor.toFixed(1)}%)`,
              );
              return { profileId: profile.id, refreshed: true, purged: true };
            }
          }
        }
        return { profileId: profile.id, refreshed: true };
      } catch (error) {
        const count = (failure?.count ?? 0) + 1;
        const next = Date.now() + Math.min(300_000 * 2 ** (count - 1), 3_600_000);
        this.failures.set(profile.id, {
          count,
          next,
        });
        const updated = this.recordReadFailure(profile.id, error, next);
        return {
          profileId: profile.id,
          refreshed: false,
          reason: updated.observationError!.reason,
          retryAt: new Date(next).toISOString(),
        };
      } finally {
        this.probes.delete(profile.id);
      }
    })();
    this.probes.set(profile.id, job);
    return job;
  }
  async inspectProfile(reference: string) {
    const profile = this.store.profile(reference);
    const existing = this.inspections.get(profile.id);
    if (existing) return existing;
    const job = this.inspectNativeProfile(profile.id)
      .catch((error) => {
        const updated = this.recordReadFailure(profile.id, error);
        return { profile: updated, reason: updated.observationError!.reason };
      })
      .finally(() => this.inspections.delete(profile.id));
    this.inspections.set(profile.id, job);
    return job;
  }
  private recordReadFailure(id: string, error: unknown, retryAt?: number) {
    const profile = this.store.require<Profile>('profile', id);
    const typed = error instanceof CodexRpcError;
    const rejected = typed && error.category === 'authentication';
    const updated = this.store.put('profile', {
      ...profile,
      ...(rejected ? { auth: 'unauthenticated' as const, authObservedAt: at() } : {}),
      observationError: {
        category: typed ? error.category : ('rpc' as const),
        reason: typed
          ? error.message
          : 'Native observation unavailable; existing data retained with its original timestamp',
        observedAt: at(),
        ...(typed ? { code: error.code, status: error.status } : {}),
        ...(retryAt ? { retryAt: new Date(retryAt).toISOString() } : {}),
      },
    });
    if (rejected)
      this.store.put('auth-observation', {
        id: `auth:${id}`,
        profileId: id,
        status: 'unauthenticated',
        account: profile.reportedAccount,
        observedAt: at(),
        source: 'Codex native authentication rejected (401)',
      });
    this.store.event('profile.observed', id);
    return updated;
  }
  private async inspectNativeProfile(
    reference: string,
  ): Promise<{ profile: Profile; reason?: string }> {
    const profile = this.store.profile(reference);
    const installation = this.installation(profile.tool);
    const conflicts = authenticationConflicts(profile);
    if (conflicts.length)
      return { profile, reason: `Conflicting authentication environment: ${conflicts.join(', ')}` };
    if (
      !installation.executable ||
      !installation.verifiedVersion ||
      !['codex', 'claude', 'copilot'].includes(profile.tool)
    )
      return {
        profile,
        reason:
          profile.tool === 'antigravity'
            ? 'Antigravity login status is not verified: no supported auth-status command was found. Open the native CLI to check your account; unknown does not mean logged out.'
            : 'Native authentication inspection is not verified for this tool/version',
      };
    let auth: Profile['auth'] = 'unknown',
      reportedAccount: string | null = null,
      plan: string | null = null;
    if (profile.tool === 'codex') {
      const [result] = await codexRead(profile, installation, [
        { method: 'account/read', params: { refreshToken: false } },
      ]);
      auth = result?.account ? 'authenticated' : 'unauthenticated';
      reportedAccount = Label.safeParse(result?.account?.email).success
        ? result.account.email
        : null;
      plan = Label.safeParse(result?.account?.planType).success ? result.account.planType : null;
    } else if (profile.tool === 'copilot') {
      const result = await copilotAuth(profile, installation);
      auth =
        result.isAuthenticated === true
          ? 'authenticated'
          : result.isAuthenticated === false
            ? 'unauthenticated'
            : 'unknown';
      reportedAccount = Label.safeParse(result.login).success ? result.login! : null;
    } else {
      const result = await exec(installation.executable, ['auth', 'status', '--json'], {
        cwd: profile.directory,
        env: profileEnvironment(profile),
        timeout: 8000,
        maxBytes: 32_768,
        allowFailure: true,
      });
      const value = JSON.parse(result.stdout.toString());
      auth =
        value.loggedIn === true
          ? 'authenticated'
          : value.loggedIn === false
            ? 'unauthenticated'
            : 'unknown';
      reportedAccount = Label.safeParse(value.email).success ? value.email : null;
      // Console/API authentication is deliberately not assigned a consumer plan.
    }
    const updated = this.store.put('profile', {
      ...this.store.require<Profile>('profile', profile.id),
      auth,
      authObservedAt: at(),
      reportedAccount,
      plan,
      observationError: null,
    });
    this.store.put('auth-observation', {
      id: randomUUID(),
      profileId: profile.id,
      status: auth,
      account: reportedAccount,
      observedAt: at(),
      source: `${profile.tool} native authentication inspection`,
    });
    this.store.event('profile.observed', profile.id);
    if (auth === 'authenticated') this.failures.delete(profile.id);
    return { profile: updated };
  }
  refreshResources(force = false) {
    if (this.resourceRefresh) return this.resourceRefresh;
    this.resourceRefresh = this.collectResources(force).finally(() => {
      this.resourceRefresh = undefined;
    });
    return this.resourceRefresh;
  }
  private async collectResources(force = false) {
    const profiles = this.store.profiles();
    const results = [];
    for (let offset = 0; offset < profiles.length; offset += 2)
      results.push(
        ...(await Promise.all(
          profiles.slice(offset, offset + 2).map((p) => this.refreshProfile(p.id, force)),
        )),
      );
    const resources = this.store.resources();
    const alerts = evaluateQuotaAlerts(
      profiles,
      resources,
      this.alertHistory,
      this.previousQuota,
    );
    for (const alert of alerts) {
      void dispatchAlert(alert).catch(() => {});
      this.store.event('alert.emitted', `${alert.title}: ${alert.message}`);
    }
    return { results, resources, alerts };
  }
  async history(raw: unknown) {
    const input = z
      .object({
        profile: Identifier,
        folder: Identifier.default('unassigned'),
        directory: z.string().optional(),
        cursor: z.string().max(1024).optional(),
      })
      .parse(raw);
    const profile = this.store.profile(input.profile);
    const installation = this.installation(profile.tool);
    if (profile.tool === 'antigravity') {
      if (profile.isolated && (profile.sharedHistory ?? true)) {
        await ensureSharedHistory(profile, installation).catch(() => {});
      }
      const imported: SessionEntry[] = [];
      for (const thread of await antigravityHistory(profile, installation)) {
        if (input.directory && path.resolve(input.directory) !== thread.directory) continue;
        try {
          if (!(await stat(thread.directory)).isDirectory()) continue;
        } catch {
          continue;
        }
        const conversation = this.store
          .list<Conversation>('conversation')
          .find((c) => c.profileId === profile.id && c.nativeId === thread.nativeId);
        const existing =
          conversation &&
          this.store.list<SessionEntry>('entry').find((e) => e.conversationId === conversation.id);
        imported.push(
          existing ??
            this.registerHistoryCopy(
              profile,
              thread.nativeId,
              thread.directory,
              input.folder,
              thread.title,
            ),
        );
      }
      return {
        imported,
        nextCursor: null,
        experimental: true,
        reason: imported.length
          ? undefined
          : 'No supported local Antigravity conversations with an existing single workspace found',
      };
    }
    if (!installation.capabilities.history.supported)
      return { imported: [], reason: installation.capabilities.history.reason, nextCursor: null };
    const conflicts = authenticationConflicts(profile);
    if (conflicts.length)
      throw new Error(`Conflicting authentication environment: ${conflicts.join(', ')}`);
    const folder = this.store.folder(input.folder);
    const [result] = await codexRead(profile, installation, [
      {
        method: 'thread/list',
        params: {
          limit: 100,
          ...(input.directory ? { cwd: await realpath(input.directory) } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
      },
    ]);
    const imported: SessionEntry[] = [];
    for (const thread of Array.isArray(result?.data) ? result.data : []) {
      if (!NativeId.safeParse(thread.id).success || typeof thread.cwd !== 'string') continue;
      let directory: string;
      try {
        directory = await realpath(thread.cwd);
        if (!(await stat(directory)).isDirectory()) continue;
      } catch {
        continue;
      }
      const project = this.store.project(directory, this.environment.id);
      const id = createHash('sha256')
        .update(`${profile.tool}:${profile.id}:${thread.id}`)
        .digest('hex')
        .slice(0, 32);
      this.store.put<Conversation>('conversation', {
        id,
        nativeId: thread.id,
        tool: profile.tool,
        profileId: profile.id,
        projectId: project.id,
      });
      const existing = this.store.list<SessionEntry>('entry').find((e) => e.conversationId === id);
      if (existing) {
        imported.push(existing);
        continue;
      }
      const title = Label.safeParse(thread.name);
      const entry = this.store.put<SessionEntry>('entry', {
        id: randomUUID(),
        folderId: folder.id,
        profileId: profile.id,
        projectId: project.id,
        tool: profile.tool,
        title: title.success ? title.data : `${profile.tool} · ${thread.id.slice(0, 8)}`,
        createdAt: at(),
        archivedAt: null,
        conversationId: id,
      });
      this.store.event('history.imported', entry.id);
      imported.push(entry);
    }
    return {
      imported,
      nextCursor: typeof result?.nextCursor === 'string' ? result.nextCursor : null,
    };
  }
  private antigravitySource(target: Profile, sourceReference?: string): Profile {
    if (target.tool !== 'antigravity') throw new Error('Choose an Antigravity destination profile');
    if (sourceReference) return this.store.profile(sourceReference);
    const directory = defaultDirectory('antigravity');
    return (
      this.store.profiles().find((p) => p.tool === 'antigravity' && p.directory === directory) ?? {
        ...target,
        id: 'native-antigravity-history',
        label: 'Native Antigravity history',
        directory,
        isolated: false,
      }
    );
  }
  async antigravityHistoryPreview(raw: unknown) {
    const input = z
      .object({ targetProfile: Identifier, sourceProfile: Identifier.optional() })
      .parse(raw);
    const target = this.store.profile(input.targetProfile),
      source = this.antigravitySource(target, input.sourceProfile);
    if (source.directory === target.directory)
      throw new Error('This profile already uses the source history; press h to list it');
    const known = this.store
      .list<Conversation>('conversation')
      .filter((c) => c.profileId === target.id);
    return {
      sourceDirectory: source.directory,
      threads: await Promise.all(
        (await antigravityHistory(source, this.installation('antigravity'))).map(async (t) => ({
          ...t,
          alreadyLoaded:
            known.some((c) => c.nativeId === t.nativeId) &&
            (await localConversationAvailable(target.directory, t.nativeId)),
        })),
      ),
      experimental: true,
    };
  }
  private async copyAntigravity(
    source: Profile,
    target: Profile,
    nativeId: string,
    folder = 'unassigned',
  ) {
    if (this.historyCopies.has(source.id) || this.historyCopies.has(target.id))
      throw new Error('A history copy is already in progress');
    this.historyCopies.add(source.id);
    this.historyCopies.add(target.id);
    try {
      if (
        this.store
          .list<Invocation>('invocation')
          .some(
            (i) => [source.id, target.id].includes(i.profileId ?? '') && i.lifecycle !== 'exited',
          )
      )
        throw new Error(
          'Finish active or uncertain invocations in both Antigravity profiles before copying',
        );
      const installation = this.installation('antigravity');
      const external = await discoverProcesses([installation]);
      const owned = this.store
        .list<Invocation>('invocation')
        .filter((i) => i.owned && i.identity && i.lifecycle !== 'exited');
      if (external.some((p) => !owned.some((i) => i.identity!.pid === p.identity.pid)))
        throw new Error(
          'Close external Antigravity CLI processes before copying; their history ownership is unverified',
        );
      const threads = await antigravityHistory(source, installation);
      const thread = threads.find((t) => t.nativeId === nativeId);
      if (!thread) throw new Error('Conversation history is unavailable');
      const copied = await copyAntigravityConversation(source, target, installation, nativeId);
      for (const dependency of copied.dependencies)
        this.registerHistoryCopy(
          target,
          dependency.nativeId,
          dependency.directory,
          folder,
          dependency.title,
          { directory: source.directory, nativeId: dependency.nativeId },
          false,
        );
      const entry = this.registerHistoryCopy(
        target,
        copied.nativeId,
        copied.directory,
        folder,
        copied.title,
        { directory: source.directory, nativeId },
        false,
      );
      return {
        entry,
        nativeId,
        copiedDependencies: copied.dependencies.length,
        experimental: true,
        nativeResumeVerified: false,
      };
    } finally {
      this.historyCopies.delete(source.id);
      this.historyCopies.delete(target.id);
    }
  }
  async loadAntigravityHistory(raw: unknown) {
    const input = z
      .object({
        targetProfile: Identifier,
        sourceProfile: Identifier.optional(),
        experimental: z.literal(true),
      })
      .parse(raw);
    const target = this.store.profile(input.targetProfile),
      source = this.antigravitySource(target, input.sourceProfile);
    const threads = await antigravityHistory(source, this.installation('antigravity'));
    let copied = 0,
      alreadyLoaded = 0;
    const failures: string[] = [];
    const initiallyKnown = new Set(
      this.store
        .list<Conversation>('conversation')
        .filter((c) => c.profileId === target.id)
        .map((c) => c.nativeId),
    );
    for (const thread of threads) {
      if (
        this.store
          .list<Conversation>('conversation')
          .some((c) => c.profileId === target.id && c.nativeId === thread.nativeId)
      ) {
        if (await localConversationAvailable(target.directory, thread.nativeId)) {
          if (initiallyKnown.has(thread.nativeId)) alreadyLoaded++;
        } else
          failures.push(
            thread.title +
              ': Registered history has no matching local database/index; it is not counted as loaded.',
          );
        continue;
      }
      try {
        const result = await this.copyAntigravity(source, target, thread.nativeId);
        copied += 1 + result.copiedDependencies;
      } catch (e) {
        failures.push(thread.title + ': ' + (e as Error).message);
      }
    }
    return { copied, alreadyLoaded, failures, experimental: true, nativeResumeVerified: false };
  }
  private async nativeHistorySource(targetId: string) {
    const target = this.store.profile(targetId);
    if (target.tool !== 'codex')
      throw new Error('Loading native history currently supports Codex only');
    const installation = this.installation('codex');
    if (
      !installation.verifiedVersion ||
      (!compatiblePatch(installation.version, '0.162.1') &&
        !compatiblePatch(installation.version, '0.163.0'))
    )
      throw new Error(
        'Loading native history requires the supported Codex patch family starting at 0.162.1 and a compatible native history contract',
      );
    let directory: string;
    try {
      directory = await realpath(defaultDirectory('codex'));
    } catch {
      throw new Error('No native Codex history directory found on this machine');
    }
    if (directory === target.directory)
      throw new Error(
        'This profile already uses native history. Press h to show its conversations.',
      );
    const source = this.store
      .profiles()
      .find((p) => p.tool === 'codex' && p.directory === directory) ?? {
      id: `native-history:${createHash('sha256').update(directory).digest('hex')}`,
      tool: 'codex' as const,
      label: 'Existing native Codex history',
      directory,
      isolated: false,
      createdAt: at(),
      auth: 'unknown' as const,
      authObservedAt: null,
      reportedAccount: null,
      plan: null,
    };
    const conflicts = [
      ...new Set([...authenticationConflicts(source), ...authenticationConflicts(target)]),
    ];
    if (conflicts.length)
      throw new Error(
        `Resolve authentication environment conflicts before copying: ${conflicts.join(', ')}`,
      );
    return { source, target, installation };
  }
  async nativeHistory(raw: unknown) {
    const input = z
      .object({
        targetProfile: Identifier,
        cursor: z.string().max(1024).optional(),
        archived: z.boolean().default(false),
      })
      .parse(raw);
    const { source, target, installation } = await this.nativeHistorySource(input.targetProfile);
    const [result] = await codexRead(source, installation, [
      {
        method: 'thread/list',
        params: {
          limit: 100,
          archived: input.archived,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
      },
    ]);
    const existing = this.store
      .list<Conversation>('conversation')
      .filter((c) => c.profileId === target.id && c.seededFrom?.directory === source.directory);
    const threads = (Array.isArray(result?.data) ? result.data : []).flatMap((thread: any) => {
      if (!NativeId.safeParse(thread.id).success || typeof thread.cwd !== 'string') return [];
      const title = Label.safeParse(thread.name);
      return [
        {
          nativeId: thread.id,
          title: title.success ? title.data : `codex · ${thread.id.slice(0, 8)}`,
          alreadyLoaded: existing.some((c) => c.seededFrom?.nativeId === thread.id),
        },
      ];
    });
    return {
      sourceDirectory: source.directory,
      threads,
      nextCursor: typeof result?.nextCursor === 'string' ? result.nextCursor : null,
    };
  }
  async seedHistory(raw: unknown) {
    const input = z
      .object({
        targetProfile: Identifier,
        sourceDirectory: z.string().max(4096),
        nativeId: NativeId,
      })
      .parse(raw);
    const { source, target, installation } = await this.nativeHistorySource(input.targetProfile);
    if (source.directory !== input.sourceDirectory)
      throw new Error('Native history location changed. Open Load existing Codex history again.');
    if (this.historyCopies.has(source.id) || this.historyCopies.has(target.id))
      throw new Error('A conversation copy is already in progress for this profile');
    const existing = this.store
      .list<Conversation>('conversation')
      .find(
        (c) =>
          c.profileId === target.id &&
          c.seededFrom?.directory === source.directory &&
          c.seededFrom.nativeId === input.nativeId,
      );
    if (existing) return { alreadyLoaded: true };
    this.historyCopies.add(source.id);
    this.historyCopies.add(target.id);
    try {
      const [result] = await codexRead(source, installation, [
        {
          method: 'thread/read',
          params: { threadId: input.nativeId, includeTurns: false },
        },
      ]);
      const thread = result?.thread;
      if (thread?.id !== input.nativeId || typeof thread.cwd !== 'string')
        throw new Error('Native conversation is unavailable');
      const sourceConversation = this.store
        .list<Conversation>('conversation')
        .find((c) => c.profileId === source.id && c.nativeId === input.nativeId);
      if (sourceConversation) {
        const entries = this.store
          .list<SessionEntry>('entry')
          .filter((e) => e.conversationId === sourceConversation.id);
        if (
          this.store
            .list<Invocation>('invocation')
            .some((i) => entries.some((e) => e.id === i.entryId) && i.lifecycle !== 'exited')
        )
          throw new Error('Finish the source conversation’s managed invocation before copying');
      }
      const directory = await realpath(thread.cwd).catch(() => {
        throw new Error('Conversation project directory no longer exists');
      });
      if (!(await stat(directory)).isDirectory())
        throw new Error('Conversation project directory no longer exists');
      this.store.profile(target.id);
      const copied = await copyCodexConversation(
        source,
        target,
        installation,
        input.nativeId,
        directory,
      );
      const title = Label.safeParse(thread.name);
      const entry = this.registerHistoryCopy(
        target,
        copied.nativeId,
        directory,
        'unassigned',
        title.success ? title.data : `codex · ${input.nativeId.slice(0, 8)}`,
        { directory: source.directory, nativeId: input.nativeId },
      );
      return { alreadyLoaded: false, entry };
    } finally {
      this.historyCopies.delete(source.id);
      this.historyCopies.delete(target.id);
    }
  }
  private registerHistoryCopy(
    target: Profile,
    nativeId: string,
    directory: string,
    folderId: string,
    title: string,
    seededFrom?: Conversation['seededFrom'],
    nativeResumeVerified?: boolean,
  ) {
    return this.store.db.transaction(() => {
      const project = this.store.project(directory, this.environment.id);
      const id = createHash('sha256')
        .update(`${target.tool}:${target.id}:${nativeId}`)
        .digest('hex')
        .slice(0, 32);
      this.store.put<Conversation>('conversation', {
        id,
        nativeId,
        tool: target.tool,
        profileId: target.id,
        projectId: project.id,
        ...(seededFrom ? { seededFrom } : {}),
        ...(nativeResumeVerified === undefined ? {} : { nativeResumeVerified }),
      });
      const entry = this.store.put<SessionEntry>('entry', {
        id: randomUUID(),
        folderId,
        profileId: target.id,
        projectId: project.id,
        tool: target.tool,
        title,
        createdAt: at(),
        archivedAt: null,
        conversationId: id,
      });
      this.store.event('history.copied', entry.id);
      return entry;
    })();
  }
  async copyHistory(raw: unknown) {
    const input = z
      .object({
        entry: Identifier,
        targetProfile: Identifier,
        directory: z.string().optional(),
        title: Label.optional(),
      })
      .parse(raw);
    const entry = this.store.require<SessionEntry>('entry', input.entry);
    if (!entry.profileId || !entry.conversationId)
      throw new Error(
        'Import the native conversation history first: /profiles → select the source profile → h',
      );
    const source = this.store.profile(entry.profileId);
    const target = this.store.profile(input.targetProfile);
    if (source.tool === 'antigravity') {
      const conversation = this.store.require<Conversation>('conversation', entry.conversationId);
      if (conversation.profileId !== source.id || conversation.tool !== source.tool)
        throw new Error('Conversation does not belong to source profile');
      const project = this.store.require<Project>('project', entry.projectId);
      if (input.directory && path.resolve(input.directory) !== project.directory)
        throw new Error(
          'Antigravity copies retain their original workspace; remapping opaque state is unsupported',
        );
      return this.copyAntigravity(source, target, conversation.nativeId, entry.folderId);
    }
    const conflicts = [
      ...new Set([...authenticationConflicts(source), ...authenticationConflicts(target)]),
    ];
    if (conflicts.length)
      throw new Error(
        `Resolve authentication environment conflicts before copying: ${conflicts.join(', ')}`,
      );
    const conversation = this.store.require<Conversation>('conversation', entry.conversationId);
    if (conversation.profileId !== source.id || conversation.tool !== source.tool)
      throw new Error('Conversation does not belong to the source profile');
    if (
      this.store
        .list<Invocation>('invocation')
        .some((i) => i.entryId === entry.id && i.lifecycle !== 'exited')
    )
      throw new Error('Finish the source conversation’s managed invocation before copying');
    if (this.historyCopies.has(source.id) || this.historyCopies.has(target.id))
      throw new Error('A conversation copy is already in progress for this profile');
    const directory = await realpath(
      input.directory ?? this.store.require<Project>('project', entry.projectId).directory,
    );
    if (!(await stat(directory)).isDirectory())
      throw new Error('Choose an existing project directory');
    // Recheck after directory resolution so concurrent requests cannot overlap.
    if (this.historyCopies.has(source.id) || this.historyCopies.has(target.id))
      throw new Error('A conversation copy is already in progress for this profile');
    this.store.profile(source.id);
    this.store.profile(target.id);
    if (
      this.store
        .list<Invocation>('invocation')
        .some((i) => i.entryId === entry.id && i.lifecycle !== 'exited')
    )
      throw new Error('Finish the source conversation’s managed invocation before copying');
    this.historyCopies.add(source.id);
    this.historyCopies.add(target.id);
    try {
      const copied = await copyCodexConversation(
        source,
        target,
        this.installation(source.tool),
        conversation.nativeId,
        directory,
      );
      const created = this.registerHistoryCopy(
        target,
        copied.nativeId,
        directory,
        entry.folderId,
        input.title ?? `${entry.title.slice(0, 150)} (copy)`,
      );
      return {
        entry: created,
        sourceEntry: entry.id,
        nativeId: copied.nativeId,
        targetProfile: target.id,
      };
    } finally {
      this.historyCopies.delete(source.id);
      this.historyCopies.delete(target.id);
    }
  }
  async exportContext(raw: unknown) {
    const input = z
      .object({
        sessionId: z.string().optional(),
        entryId: z.string().optional(),
        nativeId: z.string().optional(),
        profileId: Identifier.optional(),
        targetTool: z.string().default('antigravity'),
        saveToFile: z.boolean().default(true),
        outputPath: z.string().optional(),
        copyToClipboard: z.boolean().default(false),
      })
      .parse(raw);

    const lookupId = input.entryId ?? input.sessionId ?? input.nativeId;
    let entry: SessionEntry | undefined;
    let conversation: Conversation | undefined;
    let nativeId = input.nativeId;
    let title: string | undefined;
    let directory: string | undefined;

    if (lookupId) {
      entry = this.store.list<SessionEntry>('entry').find((e) => e.id === lookupId);
      if (entry) {
        title = entry.title;
        if (entry.conversationId) {
          conversation = this.store.require<Conversation>('conversation', entry.conversationId);
          nativeId = conversation.nativeId;
        }
        if (entry.projectId) {
          const pid = entry.projectId;
          const project = this.store.list<Project>('project').find((p) => p.id === pid);
          if (project) directory = project.directory;
        }
      } else {
        conversation = this.store
          .list<Conversation>('conversation')
          .find((c) => c.nativeId === lookupId || c.id === lookupId);
        if (conversation) {
          nativeId = conversation.nativeId;
          entry = this.store
            .list<SessionEntry>('entry')
            .find((e) => e.conversationId === conversation!.id);
          if (entry) {
            title = entry.title;
            if (entry.projectId) {
              const pid = entry.projectId;
              const project = this.store.list<Project>('project').find((p) => p.id === pid);
              if (project) directory = project.directory;
            }
          }
        } else {
          nativeId = lookupId;
        }
      }
    } else {
      const codexEntries = this.store
        .list<SessionEntry>('entry')
        .filter((e) => e.tool === 'codex')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (codexEntries.length > 0) {
        entry = codexEntries[0];
        title = entry.title;
        if (entry.conversationId) {
          conversation = this.store.require<Conversation>('conversation', entry.conversationId);
          nativeId = conversation.nativeId;
        }
        if (entry.projectId) {
          const pid = entry.projectId;
          const project = this.store.list<Project>('project').find((p) => p.id === pid);
          if (project) directory = project.directory;
        }
      }
    }

    if (!nativeId) {
      throw new Error('No conversation or native thread ID could be identified for context export');
    }

    const profileCandidates: string[] = [];
    if (conversation?.profileId) {
      const p = this.store.profiles().find((x) => x.id === conversation!.profileId);
      if (p) profileCandidates.push(p.directory);
    }
    if (input.profileId) {
      const p = this.store.profiles().find((x) => x.id === input.profileId);
      if (p && !profileCandidates.includes(p.directory)) profileCandidates.push(p.directory);
    }
    for (const p of this.store.profiles()) {
      if (p.tool === 'codex' && !profileCandidates.includes(p.directory)) {
        profileCandidates.push(p.directory);
      }
    }
    const defaultCodexDir = defaultDirectory('codex');
    if (!profileCandidates.includes(defaultCodexDir)) {
      profileCandidates.push(defaultCodexDir);
    }

    let rolloutPath: string | null = null;
    for (const dir of profileCandidates) {
      try {
        const found = await locateCodexRollout(dir, nativeId);
        if (found) {
          rolloutPath = found;
          break;
        }
      } catch {}
    }

    if (!rolloutPath) {
      throw new Error(`Could not find Codex rollout history file for thread ${nativeId}`);
    }

    const records = await readRolloutRecords(rolloutPath);
    const parsed = parseCodexRollout(records);
    if (parsed.id === 'unknown' && nativeId) {
      parsed.id = nativeId;
    }
    if (directory && (!parsed.cwd || parsed.cwd === process.cwd())) {
      parsed.cwd = directory;
    }

    const handoff = synthesizeContextHandoff(parsed, {
      title,
      targetTool: input.targetTool,
    });

    let savedPath: string | null = null;
    if (input.saveToFile) {
      savedPath = await saveHandoffDocument(
        parsed.cwd || directory || process.cwd(),
        parsed.id,
        handoff.handoffMarkdown,
        input.outputPath,
      );
    }

    let copied = false;
    if (input.copyToClipboard) {
      copied = await copyToClipboard(handoff.summaryPrompt);
    }

    return {
      nativeId: parsed.id,
      title: handoff.title,
      directory: parsed.cwd,
      filesModified: handoff.filesModified,
      totalTurns: parsed.totalTurns,
      savedPath,
      copiedToClipboard: copied,
      summaryPrompt: handoff.summaryPrompt,
      handoffMarkdown: handoff.handoffMarkdown,
    };
  }
  async purgeHandoffProfile(
    profile: Profile,
    status: 'time-expired' | 'quota-exhausted',
    reason: string,
  ) {
    // 1. Force stop and finish any active invocations for this profile
    const running = this.store
      .list<Invocation>('invocation')
      .filter((i) => i.profileId === profile.id && i.lifecycle !== 'exited');
    for (const inv of running) {
      try {
        if (inv.owned && inv.identity && inv.wrapper) {
          await forceStopOwned(inv.identity, inv.wrapper);
        }
      } catch {}
      this.store.finish(inv, 137);
    }

    // 2. Wipe profile disk directory and isolated sandboxes
    const profileRoot = path.join(managementPaths.profiles, profile.id);
    try {
      await rm(profileRoot, { recursive: true, force: true });
    } catch {}
    if (profile.directory && profile.directory !== profileRoot) {
      try {
        await rm(profile.directory, { recursive: true, force: true });
      } catch {}
    }

    // 3. Clear in-memory daemon state
    this.probes.delete(profile.id);
    this.inspections.delete(profile.id);
    this.historyCopies.delete(profile.id);
    this.failures.delete(profile.id);
    this.previousQuota.delete(profile.id);

    // 4. Wipe all records from database (profile, resources, auth observations, conversations, bindings, active-profiles)
    const result = this.store.purgeProfile(profile.id);

    console.log(
      `[handoff] Profile ${profile.label} (${profile.id}) limit reached (${status}: ${reason}). Purged profile, credentials, sandboxes, and usage data everywhere.`,
    );

    return result;
  }
  async scrubHandoffCredentials(
    profile: Profile,
    status: 'time-expired' | 'quota-exhausted',
    reason: string,
  ) {
    return await this.purgeHandoffProfile(profile, status, reason);
  }
  async exportAccountHandoff(raw: unknown) {
    const input = z
      .object({
        profile: z.string().optional(),
        tool: z.preprocess((v) => (typeof v === 'string' ? normalizeTool(v) ?? v : v), Tool).optional(),
        passphrase: z.string().optional(),
        label: z.string().optional(),
        timeLimit: z.union([z.string(), z.number()]).optional(),
        quotaLimit: z.union([z.string(), z.number()]).optional(),
        outputPath: z.string().optional(),
        copyToClipboard: z.boolean().default(false),
      })
      .parse(raw);

    let profile: Profile | undefined;
    if (input.profile) {
      profile = this.store.profiles().find((p) => p.id === input.profile || p.label === input.profile);
    } else if (input.tool) {
      const activeId = this.store.activeProfiles()[input.tool];
      profile =
        (activeId ? this.store.profiles().find((p) => p.id === activeId) : undefined) ??
        this.store.profiles().find((p) => p.tool === input.tool && p.auth === 'authenticated') ??
        this.store.profiles().find((p) => p.tool === input.tool);
    } else {
      for (const t of ['antigravity', 'codex'] as Tool[]) {
        const activeId = this.store.activeProfiles()[t];
        profile =
          (activeId ? this.store.profiles().find((p) => p.id === activeId) : undefined) ??
          this.store.profiles().find((p) => p.tool === t && p.auth === 'authenticated');
        if (profile) break;
      }
    }

    if (!profile) {
      throw new Error('No suitable profile found to export handoff from. Specify a profile or tool.');
    }

    if (!['antigravity', 'codex'].includes(profile.tool)) {
      throw new Error(`Account handoff is not supported for ${profile.tool}`);
    }

    let timeLimitHours: number | undefined;
    if (input.timeLimit !== undefined) {
      timeLimitHours = parseDurationToHours(input.timeLimit);
    }

    let quotaLimitPercent: number | undefined;
    if (input.quotaLimit !== undefined) {
      if (typeof input.quotaLimit === 'number') {
        quotaLimitPercent = input.quotaLimit;
      } else {
        const match = String(input.quotaLimit).trim().match(/^([\d.]+)\s*%?$/);
        if (match) quotaLimitPercent = parseFloat(match[1]);
      }
      if (
        quotaLimitPercent === undefined ||
        !Number.isFinite(quotaLimitPercent) ||
        quotaLimitPercent <= 0 ||
        quotaLimitPercent > 100
      ) {
        throw new Error(
          'Quota limit must be a positive percentage between 0 and 100 (e.g. 20 or 20%)',
        );
      }
    }

    const baseline = this.profileHeadroom(profile.id) ?? 100;
    const allowedQuotaFloor =
      quotaLimitPercent !== undefined ? Math.max(0, baseline - quotaLimitPercent) : undefined;

    const { bundle, armoredToken, emailHint, constraints } = await createHandoffBundle(profile, {
      passphrase: input.passphrase,
      customLabel: input.label,
      timeLimitHours,
      quotaLimitPercent,
      baselineQuotaRemaining: baseline,
      allowedQuotaFloor,
    });

    let savedPath: string | undefined;
    if (input.outputPath) {
      const resolved = path.resolve(input.outputPath);
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, JSON.stringify(bundle, null, 2) + '\n', { mode: 0o600 });
      savedPath = resolved;
    }

    let copied = false;
    if (input.copyToClipboard) {
      copied = await copyHandoffClipboard(armoredToken);
    }

    return {
      bundle,
      armoredToken,
      accountHint: emailHint,
      constraints,
      savedPath,
      copiedToClipboard: copied,
      profileLabel: profile.label,
      tool: profile.tool,
    };
  }
  async importAccountHandoff(raw: unknown) {
    const input = z
      .object({
        data: z.string().min(1),
        passphrase: z.string().optional(),
        label: z.string().optional(),
      })
      .parse(raw);

    let bundleText = input.data.trim();
    try {
      const s = await stat(bundleText);
      if (s.isFile()) {
        bundleText = await readFile(bundleText, 'utf8');
      }
    } catch {}

    const { bundle, credentialsPayload, constraints } = parseAndValidateBundle(
      bundleText,
      input.passphrase,
    );
    const installation = this.installation(bundle.tool);

    let targetLabel = input.label?.trim() || bundle.label || `${bundle.tool}-shared`;
    const existing = this.store.profiles();
    if (existing.some((p) => p.label === targetLabel)) {
      let counter = 1;
      while (existing.some((p) => p.label === `${targetLabel}-${counter}`)) {
        counter++;
      }
      targetLabel = `${targetLabel}-${counter}`;
    }

    const profile = await this.addProfile({
      tool: bundle.tool,
      label: targetLabel,
      isolated: true,
      sharedHistory: true,
      handoff: true,
    });

    if (!profile) {
      throw new Error('Failed to create isolated profile for handoff');
    }

    if (bundle.tool === 'antigravity') {
      await writeFile(
        path.join(profile.directory, 'antigravity-oauth-token'),
        JSON.stringify(credentialsPayload, null, 2) + '\n',
        { mode: 0o600 },
      );
      await ensureSharedHistory(profile, installation).catch(() => {});
    } else if (bundle.tool === 'codex') {
      await writeFile(
        path.join(profile.directory, 'auth.json'),
        JSON.stringify(credentialsPayload, null, 2) + '\n',
        { mode: 0o600 },
      );
      const configPath = path.join(profile.directory, 'config.toml');
      try {
        await stat(configPath);
      } catch {
        await writeFile(
          configPath,
          'cli_auth_credentials_store = "file"\nmodel_provider = "openai"\n',
          { mode: 0o600 },
        );
      }
    }

    const updatedProfile = this.store.put<Profile>('profile', {
      ...profile,
      auth: 'authenticated',
      authObservedAt: at(),
      reportedAccount: bundle.accountHint,
      handoffConstraints: constraints
        ? {
            ...constraints,
            importedAt: at(),
            status: 'active',
          }
        : undefined,
    });

    this.store.put('auth-observation', {
      id: randomUUID(),
      profileId: profile.id,
      observedAt: at(),
      status: 'authenticated',
      error: null,
      source: `${profile.tool} account handoff import`,
    });

    this.store.event('profile.created', profile.id);

    return {
      profile: updatedProfile,
      tool: bundle.tool,
      label: targetLabel,
      accountHint: bundle.accountHint,
      directory: profile.directory,
      constraints: updatedProfile.handoffConstraints,
    };
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const invocation of this.store
        .list<Invocation>('invocation')
        .filter((i) => i.lifecycle !== 'exited')) {
        try {
          if (invocation.identity) {
            if (!(await identityMatches(invocation.identity))) {
              // Retain the profile lease while its helper flushes and closes the keyring.
              if (invocation.runtimeIdentity && (await identityMatches(invocation.runtimeIdentity)))
                continue;
              this.store.finish(invocation, null);
              continue;
            }
            const terminal = await controllingTerminal(invocation.identity);
            if (terminal !== invocation.hasControllingTerminal)
              this.store.updateInvocation(invocation.id, { hasControllingTerminal: terminal });
            if (invocation.lifecycle === 'unknown') {
              this.store.updateInvocation(invocation.id, { lifecycle: 'running' });
              this.store.event('invocation.reconciled', invocation.id);
            }
            const stale = Date.now() - Date.parse(invocation.observedAt) > 300_000;
            if (stale && invocation.connection !== 'stale') {
              this.store.updateInvocation(invocation.id, {
                connection: 'stale',
                activity: 'unknown',
              });
              this.store.event('invocation.stale', invocation.id);
            }
            if (invocation.profileId) {
              let prof: Profile | null = null;
              try {
                prof = this.store.profile(invocation.profileId);
              } catch {}
              if (prof?.handoffConstraints) {
                const { expiresAt, timeLimitHours, allowedQuotaFloor, quotaLimitPercent } =
                  prof.handoffConstraints;
                if (expiresAt && Date.now() >= Date.parse(expiresAt)) {
                  void this.stop(invocation.id).catch(() => {});
                  await this.purgeHandoffProfile(
                    prof,
                    'time-expired',
                    `Handoff time limit (${timeLimitHours ?? 'N'}h) expired`,
                  );
                } else if (allowedQuotaFloor !== undefined) {
                  const currentHeadroom = this.profileHeadroom(prof.id);
                  if (currentHeadroom !== undefined && currentHeadroom <= allowedQuotaFloor) {
                    void this.stop(invocation.id).catch(() => {});
                    await this.purgeHandoffProfile(
                      prof,
                      'quota-exhausted',
                      `Handoff quota budget (${quotaLimitPercent}%) exhausted`,
                    );
                  }
                }
              }
            }
          } else if (invocation.wrapper && !(await identityMatches(invocation.wrapper))) {
            if (invocation.lifecycle !== 'unknown' || invocation.connection !== 'disconnected') {
              this.store.updateInvocation(invocation.id, {
                lifecycle: 'unknown',
                connection: 'disconnected',
              });
              this.store.event('invocation.uncertain', invocation.id);
            }
          }
        } catch {
          if (invocation.lifecycle !== 'unknown') {
            this.store.updateInvocation(invocation.id, {
              lifecycle: 'unknown',
              connection: 'disconnected',
            });
            this.store.event('invocation.uncertain', invocation.id);
          }
        }
      }
      for (const prof of this.store.profiles()) {
        if (!prof.handoffConstraints) continue;
        const { expiresAt, timeLimitHours, allowedQuotaFloor, quotaLimitPercent } =
          prof.handoffConstraints;
        if (expiresAt && Date.now() >= Date.parse(expiresAt)) {
          await this.purgeHandoffProfile(
            prof,
            'time-expired',
            `Handoff time limit (${timeLimitHours ?? 'N'}h) expired`,
          );
        } else if (allowedQuotaFloor !== undefined) {
          const currentHeadroom = this.profileHeadroom(prof.id);
          if (currentHeadroom !== undefined && currentHeadroom <= allowedQuotaFloor) {
            await this.purgeHandoffProfile(
              prof,
              'quota-exhausted',
              `Handoff quota budget (${quotaLimitPercent}%) exhausted`,
            );
          }
        }
      }
      if (Date.now() - this.lastDiscovery >= 30_000) {
        this.lastDiscovery = Date.now();
        for (const item of await discoverProcesses(this.installations)) {
          // Exclude helpers and descendants already covered by an owned launch.
          const parents = await ancestors(item.identity.pid);
          if (parents.includes(process.pid)) continue; // Observation helper processes are not user agents.
          if (
            this.store
              .list<Invocation>('invocation')
              .some(
                (i) =>
                  i.owned &&
                  i.lifecycle !== 'exited' &&
                  ((i.identity && parents.includes(i.identity.pid)) ||
                    (i.wrapper && parents.includes(i.wrapper.pid))),
              )
          )
            continue;
          this.registerExternal(item);
        }
      }
      if (Date.now() - this.lastRefresh >= Number(process.env.PRINCIPAL_REFRESH_INTERVAL || 60_000)) {
        this.lastRefresh = Date.now();
        if (Date.now() - this.lastInstallationCheck >= 300_000) {
          this.installations = await detectInstallations();
          this.lastInstallationCheck = Date.now();
        }
        if (this.store.profiles().length) void this.refreshResources(false).catch(() => {});
      }
      if (Date.now() - this.lastPruned >= 3_600_000) {
        this.lastPruned = Date.now();
        this.store.prune();
      }
    } finally {
      this.ticking = false;
    }
  }
  async rpc(method: string, raw: unknown = {}) {
    switch (method) {
      case 'snapshot':
        return this.snapshot();
      case 'diagnostics.report': {
        this.installations = await detectInstallations();
        this.lastInstallationCheck = Date.now();
        const report: DiagnosticsReport = {
          checkedAt: at(),
          tools: this.installations,
          isolation: await isolationHealth(),
          profiles: [],
        };
        const profiles = this.store.profiles();
        for (let offset = 0; offset < profiles.length; offset += 2) {
          report.profiles.push(
            ...(await Promise.all(
              profiles.slice(offset, offset + 2).map(async (profile) => {
                const result = await this.inspectProfile(profile.id);
                const current = result.profile;
                const error = current.observationError;
                const status =
                  error?.category === 'authentication' || current.auth === 'unauthenticated'
                    ? 'Unauthorized'
                    : error?.category === 'network'
                      ? 'Unreachable'
                      : !result.reason && current.auth === 'authenticated'
                        ? 'Healthy'
                        : 'Not Verified';
                return {
                  id: current.id,
                  label: current.label,
                  tool: current.tool,
                  status,
                  reason:
                    result.reason ??
                    (status === 'Healthy'
                      ? 'Native authentication read succeeded; quota availability is checked separately.'
                      : 'Sign in through /profiles; token expiry and server authorization are separate checks.'),
                  checkedAt: current.authObservedAt,
                  credential: await credentialExpiry(current),
                } as DiagnosticsReport['profiles'][number];
              }),
            )),
          );
        }
        return report;
      }
      case 'events':
        return {
          seq: this.store.seq,
          events: this.store.events(
            z.object({ after: z.number().int().nonnegative() }).parse(raw).after,
          ),
        };
      case 'installations.refresh':
        this.installations = await detectInstallations();
        this.lastInstallationCheck = Date.now();
        return this.installations;
      case 'accounts.dismiss':
        return this.store.dismissAccounts(
          z.object({ ids: z.array(z.string().uuid()).max(1000) }).parse(raw).ids,
        );
      case 'profiles.add':
        return this.addProfile(raw);
      case 'profiles.rename': {
        const input = z.object({ profile: Identifier, label: z.unknown() }).parse(raw);
        return this.renameProfile(input.profile, input.label);
      }
      case 'profiles.remove':
        return this.removeProfile(z.object({ profile: Identifier }).parse(raw).profile);
      case 'profiles.purge': {
        const id = z.object({ profile: Identifier }).parse(raw).profile;
        const prof = this.store.profile(id);
        return this.purgeHandoffProfile(prof, 'time-expired', 'Manual purge requested');
      }
      case 'profiles.list':
        return this.store.profiles();
      case 'profiles.inspect':
        return this.inspectProfile(z.object({ profile: Identifier }).parse(raw).profile);
      case 'profiles.active':
        return this.activeProfilesReport();
      case 'profiles.swap':
        return this.swapProfile(raw);
      case 'profiles.login.prepare': {
        const profile = this.store.profile(z.object({ profile: Identifier }).parse(raw).profile);
        if (
          this.store
            .list<Invocation>('invocation')
            .some((i) => i.profileId === profile.id && i.lifecycle !== 'exited')
        )
          throw new Error('Finish managed invocations before changing authentication');
        if (this.historyCopies.has(profile.id))
          throw new Error('Finish the conversation copy before changing authentication');
        const probe = this.probes.get(profile.id);
        if (probe) await probe;
        this.store.put('profile', {
          ...this.store.profile(profile.id),
          auth: 'unknown',
          authObservedAt: at(),
          reportedAccount: null,
          plan: null,
        });
        this.store.event('profile.auth-invalidated', profile.id);
        return { ready: true };
      }
      case 'launch.prepare':
        return this.prepare(raw);
      case 'launch.register':
        return this.registered(raw);
      case 'launch.exit': {
        const { id, exitCode } = z
          .object({ id: z.string().uuid(), exitCode: z.number().int().nullable() })
          .parse(raw);
        const invocation = this.store.require<Invocation>('invocation', id);
        if (!invocation.owned) throw new Error('Cannot modify an external process');
        if (invocation.identity && (await identityMatches(invocation.identity)))
          throw new Error('Process is still alive');
        this.store.finish(invocation, exitCode);
        return { recorded: true };
      }
      case 'entries.reopen':
        return this.reopenPlan(raw);
      case 'invocations.stop': {
        const input = z
          .object({ id: z.string().uuid(), force: z.boolean().default(false) })
          .parse(raw);
        return this.stop(input.id, input.force);
      }
      case 'invocations.control': {
        const input = z.object({ id: z.string().uuid(), wrapper: Identity }).parse(raw);
        const invocation = this.store.require<Invocation>('invocation', input.id);
        if (
          !invocation.owned ||
          !invocation.wrapper ||
          invocation.wrapper.pid !== input.wrapper.pid ||
          invocation.wrapper.startTime !== input.wrapper.startTime ||
          invocation.wrapper.bootId !== input.wrapper.bootId ||
          !(await identityMatches(input.wrapper))
        )
          throw new Error('Control requester is not the live launch wrapper');
        return { stopRequestedAt: invocation.stopRequestedAt ?? null };
      }
      case 'observe':
        return this.observe(raw);
      case 'folders.create': {
        const input = z.object({ path: z.string().min(1).max(2048) }).parse(raw);
        const names = z.array(FolderName).min(1).max(32).parse(input.path.split('/'));
        return this.store.createFolder(names);
      }
      case 'folders.update': {
        const input = z
          .object({
            id: Identifier,
            name: FolderName.optional(),
            parent: Identifier.nullable().optional(),
            order: z.number().int().nonnegative().optional(),
          })
          .parse(raw);
        return this.store.updateFolder(input.id, {
          ...(input.name ? { name: input.name } : {}),
          ...(input.parent !== undefined
            ? { parentId: input.parent === null ? null : this.store.folder(input.parent).id }
            : {}),
          ...(input.order === undefined ? {} : { order: input.order }),
        });
      }
      case 'folders.delete':
        return this.store.deleteFolder(z.object({ id: Identifier }).parse(raw).id);
      case 'entries.update': {
        const input = z
          .object({
            id: z.string().uuid(),
            title: Label.optional(),
            folder: Identifier.optional(),
            archived: z.boolean().optional(),
          })
          .parse(raw);
        return this.store.updateEntry(input.id, {
          ...(input.title ? { title: input.title } : {}),
          ...(input.folder ? { folderId: this.store.folder(input.folder).id } : {}),
          ...(input.archived === undefined ? {} : { archivedAt: input.archived ? at() : null }),
        });
      }
      case 'history.antigravity.preview':
        return this.antigravityHistoryPreview(raw);
      case 'history.antigravity.load':
        return this.loadAntigravityHistory(raw);
      case 'history.read':
        return this.history(raw);
      case 'history.native':
        return this.nativeHistory(raw);
      case 'history.seed':
        return this.seedHistory(raw);
      case 'history.copy':
        return this.copyHistory(raw);
      case 'context.export':
        return this.exportContext(raw);
      case 'handoff.export':
        return this.exportAccountHandoff(raw);
      case 'handoff.import':
        return this.importAccountHandoff(raw);
      case 'resources':
        return this.store.resources();
      case 'resources.refresh':
        return this.refreshResources(true);
      case 'ui.save': {
        const input = z
          .object({
            expanded: z.array(z.string().max(600)).max(10_000),
            selected: z.string().max(600).nullable(),
          })
          .parse(raw);
        this.store.saveUI(input);
        return { saved: true };
      }
      default:
        throw new Error('Unsupported management operation');
    }
  }
}
