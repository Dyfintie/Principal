import { managementRpc } from '../../client.js';
import { defaultDirectory } from '../../providers.js';
import { nativeArguments } from '../../arguments.js';
import { usageTools, type ProfileInventoryRow } from '../../../unified-inventory.js';
import type { Profile, Snapshot, Project } from '../../model.js';
import type { TreeRow } from '../../tree.js';
import type { Dialog, Field } from '../modals/FormDialog.js';
import type { Handoff } from '../types.js';
interface Context {
  snapshot: Snapshot | null;
  selectedTool: (typeof usageTools)[number];
  profileRows: ProfileInventoryRow[];
  selectedProfile?: Profile;
  initialDirectory: string;
  tab: number;
  project?: Project;
  row?: TreeRow;
  setListIndex: (index: number) => void;
  setMessage: (message: string) => void;
  act: (action: () => Promise<void>) => Promise<void>;
  leave: (request: Handoff) => Promise<void>;
  form: (title: string, fields: Field[], submit: Dialog['submit'], description?: string[]) => void;
  pendingProfileSelection: { current: string | null };
  showText: (title: string, text: string) => void;
  reveal: (folderId: string, value: Snapshot, projectId?: string) => void;
  focus: (id: string | null) => void;
}
export function createProfileActions({
  snapshot,
  selectedTool,
  profileRows,
  selectedProfile,
  initialDirectory,
  tab,
  project,
  row,
  setListIndex,
  setMessage,
  act,
  leave,
  form,
  pendingProfileSelection,
  showText,
  reveal,
  focus,
}: Context) {
  function addAccount(existingLogin = false) {
    if (!snapshot) return;
    const installation = snapshot.installations.find((i) => i.tool === selectedTool.id);
    if (!installation?.executable) {
      setMessage(
        `Install ${selectedTool.label} first, then use /diagnostics to recheck installed tools.`,
      );
      return;
    }
    const shared = snapshot.profiles.find(
      (p) => p.tool === selectedTool.id && p.directory === defaultDirectory(selectedTool.id),
    );
    const isolated = !existingLogin && installation.capabilities.configurationIsolation.supported;
    if (selectedTool.id === 'antigravity' && !existingLogin && !isolated) {
      antigravitySignIn(shared);
      return;
    }
    if (shared && !isolated) {
      if (existingLogin) {
        setListIndex(profileRows.findIndex((p) => p.nativeProfile?.id === shared.id));
        setMessage('Existing native login is already registered. Press s to launch.');
      } else void act(() => leave({ kind: 'login', id: shared.id }));
      return;
    }
    form(
      `${existingLogin ? 'Use existing login' : 'Add account and sign in'} · ${selectedTool.label}${!existingLogin && !isolated ? ' · shared native login' : ''}`,
      [{ label: 'Profile name', value: '' }],
      async ([label]) => {
        const added = await managementRpc('profiles.add', {
          tool: selectedTool.id,
          label,
          isolated,
        });
        pendingProfileSelection.current = added.id;
        if (!existingLogin) await leave({ kind: 'login', id: added.id });
        else {
          try {
            await managementRpc('profiles.inspect', { profile: added.id });
          } catch {}
          setMessage('Existing native login added. Press s to launch; l to sign in if needed.');
        }
      },
      selectedTool.id === 'antigravity' && isolated
        ? [
            'Experimental: this account gets its own home directory and encrypted private keyring.',
            'Native agy opens Google sign-in. Choose the Google account for this profile, then exit to return.',
            'Principal sets up the usage statusline in this new profile; your existing native settings stay unchanged.',
            'Different profiles can run in separate terminals. Each profile permits one active agent.',
            'Desktop Secret Service must be unlocked. Actual two-account refresh remains unverified.',
          ]
        : undefined,
    );
  }
  function antigravitySignIn(existing?: Profile, signIn = false) {
    if (existing?.isolated) {
      form(
        'Antigravity · sign in to ' + existing.label,
        [],
        async () => leave({ kind: 'login', id: existing.id }),
        [
          'This profile uses a private home and encrypted keyring; other profiles stay separate.',
          'Native agy opens Google sign-in if needed, otherwise it uses this profile’s saved login.',
          'Exit the native tool to return. Sign-in and token refresh remain provider controlled.',
          'Experimental Linux isolation: one active agent per profile; live two-account refresh unverified.',
        ],
      );
      return;
    }
    form(
      'Antigravity · connect your native login',
      [
        ...(!existing ? [{ label: 'Profile name', value: 'antigravity' }] : []),
        {
          label: 'Action',
          value: signIn ? 'Open native sign-in' : 'Use existing login',
          choices: ['Use existing login', 'Open native sign-in'],
        },
      ],
      async (values) => {
        const action = values[existing ? 0 : 1];
        const added =
          existing ??
          (await managementRpc('profiles.add', {
            tool: 'antigravity',
            label: values[0],
            isolated: false,
          }));
        pendingProfileSelection.current = added.id;
        if (action === 'Open native sign-in') {
          await leave({ kind: 'login', id: added.id });
        } else {
          setMessage(
            'Native Antigravity configuration connected. Login is not independently verified; press s to launch.',
          );
        }
      },
      [
        'Use existing login connects Principal without opening the agent or changing credentials.',
        'Open native sign-in starts agy. It opens Google sign-in if no saved login exists;',
        'otherwise it opens the agent with that existing login. Exit it to return to Principal.',
        'This entry uses the shared native login. Add account creates a separate experimental profile when dependencies are available.',
        'To switch accounts, use native /logout and sign in again. This changes the shared login.',
        'Principal does not log you out automatically or send an agent prompt.',
      ],
    );
  }
  function loadAntigravityHistory(profile: Profile) {
    const sources = [
      { id: undefined as string | undefined, label: 'Native Antigravity history' },
      ...(snapshot?.profiles
        .filter((p) => p.tool === 'antigravity' && p.directory !== profile.directory)
        .map((p) => ({ id: p.id, label: `Profile: ${p.label}` })) ?? []),
    ];
    form(
      `Load Antigravity history · ${profile.label} · experimental`,
      [{ label: 'Source history', value: sources[0]!.label, choices: sources.map((p) => p.label) }],
      async ([label]) => {
        const sourceProfile = sources.find((p) => p.label === label)?.id;
        const options = { targetProfile: profile.id, ...(sourceProfile ? { sourceProfile } : {}) };
        const preview = await managementRpc('history.antigravity.preview', options);
        form(
          'Confirm experimental history copy',
          [],
          async () => {
            const result = await managementRpc(
              'history.antigravity.load',
              { ...options, experimental: true },
              90_000,
            );
            const latest: Snapshot = await managementRpc('snapshot');
            const copied = latest.entries.find(
              (e) => e.profileId === profile.id && e.conversationId,
            );
            if (copied) reveal(copied.folderId, latest, copied.projectId);
            showText(
              'Antigravity history loading results',
              `Copied ${result.copied}; already loaded ${result.alreadyLoaded}; failed ${result.failures.length}.\nIndependent local snapshots; native IDs preserved. Cross-account continuation is unverified.\n${result.failures.join('\n')}\nOpen /sessions to inspect the copied entries.`,
            );
          },
          [
            `${preview.threads.filter((t: any) => !t.alreadyLoaded).length} supported local conversations will be attempted.`,
            'Credentials stay separate. Native IDs and original workspace paths are retained.',
            'Snapshots do not synchronize; native cross-account continuation is unverified.',
            'Stop both profiles and external Antigravity CLIs. Unsupported dependencies are skipped.',
          ],
        );
      },
      [
        'Choose native history to hydrate this profile, or another profile to copy its history.',
        'Experimental SQLite history: storage schemas are checked before copying; native cross-account continuation remains unverified. Existing IDs are never overwritten.',
      ],
    );
  }
  async function jumpProfile(selected: Profile) {
    const latest: Snapshot = await managementRpc('snapshot');
    const invocations = latest.invocations.filter(
      (i) => i.profileId === selected.id && i.lifecycle !== 'exited',
    );
    const runs = invocations.flatMap((i) => {
      const entry = latest.entries.find((e) => e.id === i.entryId);
      const project = entry && latest.projects.find((p) => p.id === entry.projectId);
      return entry
        ? [
            {
              entry,
              label: `${entry.title} · ${project?.name ?? 'workspace unknown'} · run ${i.id.slice(0, 8)}`,
            },
          ]
        : [];
    });
    if (!runs.length) {
      setMessage(
        `No current run is recorded for ${selected.label}. Press s to launch its native tool, or h to show its saved conversations.`,
      );
      return;
    }
    if (runs.length === 1) {
      await reopenForm(runs[0]!.entry, selected.label);
      return;
    }
    form(
      `Choose a current run · ${selected.label}`,
      [{ label: 'Running session', value: runs[0]!.label, choices: runs.map((r) => r.label) }],
      async ([label]) => {
        const run = runs.find((r) => r.label === label);
        if (!run) throw new Error('Select a recorded run');
        await reopenForm(run.entry, selected.label);
      },
      [
        'Choose this profile’s run to reopen here. No process is stopped until you confirm the next screen.',
      ],
    );
  }
  async function reopenForm(selected: Snapshot['entries'][number], profileLabel?: string) {
    const plan = await managementRpc('entries.reopen', { entry: selected.id });
    if (plan.mode === 'attach') {
      form(
        'Attach to current running agent' + (profileLabel ? ' · ' + profileLabel : ''),
        [],
        async () => {
          await leave({ kind: 'reopen', id: selected.id });
        },
        [
          'This opens the existing persistent terminal without stopping the agent or resuming a new conversation.',
          'Ctrl+b, then d detaches back to Principal; the native agent keeps running.',
        ],
      );
      return;
    }
    form(
      (plan.stopInvocationId
        ? 'Stop owned agent and reopen on this terminal'
        : 'Reopen conversation on this terminal') + (profileLabel ? ` · ${profileLabel}` : ''),
      plan.forceStopAvailable
        ? [
            {
              label: 'Stop method',
              value: 'Graceful stop',
              choices: ['Graceful stop', 'Force stop and reopen'],
            },
          ]
        : [],
      async (values) => {
        await leave({
          kind: 'reopen',
          id: selected.id,
          stopInvocationId: plan.stopInvocationId,
          experimentalHistory: !!plan.experimentalHistory,
          forceStop: values[0] === 'Force stop and reopen',
        });
      },
      [
        'Reopens the official native CLI with the original profile and workspace; no prompt is sent.',
        ...(plan.stopInvocationId
          ? [
              'A live process still exists. Enter requests a graceful stop; unfinished work may be interrupted.',
              'Principal waits for the old process and isolated runtime to exit before launching again.',
            ]
          : []),
        ...(plan.waitingForExit
          ? ['The previous private runtime is shutting down; reopening waits for it.']
          : []),
        ...(plan.forceStopAvailable
          ? [
              'The previous graceful stop has stalled. Choose Force stop and reopen with ←/→ if needed.',
              'Force stop kills only the verified owned native process. Unfinished work and unsaved changes may be lost.',
              'The private keyring runtime is allowed to shut down normally before a new agent starts.',
            ]
          : []),
        ...(plan.mode === 'latest'
          ? [
              'No conversation ID was observed. Antigravity --continue attempts the most recent conversation in this profile/workspace.',
              'This cannot guarantee the exact unobserved conversation. If none is found, use the native resume picker.',
            ]
          : []),
        ...(plan.mode === 'native'
          ? [
              'The installed CLI did not confirm --continue. Open native Antigravity and select history with /resume.',
            ]
          : []),
        ...(plan.mode === 'picker'
          ? ['No conversation ID was observed; choose history in the native resume picker.']
          : []),
        ...(plan.experimentalHistory
          ? ['Copied Antigravity history: native cross-account continuation remains unverified.']
          : []),
        'This restarts a local UI from saved history; it does not attach to a live process or download remote sessions.',
      ],
    );
  }
  function copyAntigravityForm(sourceEntry: Snapshot['entries'][number]) {
    const targets =
      snapshot?.profiles.filter(
        (p) => p.tool === 'antigravity' && p.isolated && p.id !== sourceEntry.profileId,
      ) ?? [];
    if (!sourceEntry.conversationId || !targets.length) {
      setMessage(
        'Import the source history with h and add a second isolated Antigravity profile first.',
      );
      return;
    }
    form(
      'Copy Antigravity conversation · experimental local snapshot',
      [
        {
          label: 'Destination profile',
          value: targets[0]!.label,
          choices: targets.map((p) => p.label),
        },
      ],
      async ([label]) => {
        const result = await managementRpc(
          'history.copy',
          { entry: sourceEntry.id, targetProfile: targets.find((p) => p.label === label)!.id },
          90_000,
        );
        const latest = await managementRpc('snapshot');
        reveal(result.entry.folderId, latest, result.entry.projectId);
        focus(`e:${result.entry.id}`);
        setMessage(
          'Local snapshot copied; native ID and workspace retained. Independent files, no synchronization; native cross-account continuation unverified.',
        );
      },
      [
        'Preserves all supported SQLite records without rewriting opaque protobufs.',
        'Native IDs and the original workspace are retained; destination login stays separate.',
        'Close both profiles first. Existing destination IDs and unsupported dependencies are refused.',
        'Native continuation under another account remains unverified.',
      ],
    );
  }
  function launchForm(chosenProfile = selectedProfile?.label ?? snapshot?.profiles[0]?.label) {
    if (!snapshot?.profiles.length) {
      setMessage('No profiles yet. Use /profiles to add an existing login or a new profile.');
      return;
    }
    form(
      `Launch native agent · ${snapshot.profiles.find((p) => p.label === chosenProfile)?.tool ?? 'select profile'} · return after detach or exit`,
      [
        { label: 'Profile', value: chosenProfile!, choices: snapshot.profiles.map((p) => p.label) },
        {
          label: 'Project directory',
          value: (tab === 0 ? project?.directory : undefined) ?? initialDirectory,
        },
        { label: 'Title (optional)', value: '' },
        { label: 'Native options (quoted words, no shell)', value: '' },
        {
          label: 'Authentication environment overrides',
          value: 'Refuse',
          choices: ['Refuse', 'Allow explicitly'],
        },
        {
          label: 'Terminal mode',
          value: 'Automatic',
          choices: ['Automatic', 'Persistent (tmux)', 'Direct'],
        },
      ],
      async ([profile, directory, title, options, overrides, terminalMode]) =>
        leave({
          kind: 'launch',
          options: {
            profile: snapshot.profiles.find((p) => p.label === profile)?.id ?? profile,
            directory,
            title: title || undefined,
            args: nativeArguments(options),
            allowAuthEnv: overrides === 'Allow explicitly',
            multiplex:
              terminalMode === 'Automatic' ? undefined : terminalMode === 'Persistent (tmux)',
            folder: row?.folderId ?? 'unassigned',
          },
        }),
    );
  }
  return {
    addAccount,
    antigravitySignIn,
    loadAntigravityHistory,
    jumpProfile,
    reopenForm,
    copyAntigravityForm,
    launchForm,
  };
}
