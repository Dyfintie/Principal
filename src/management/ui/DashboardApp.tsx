import { useManagementSnapshot } from './hooks/useManagementSnapshot.js';
import type { Handoff } from './types.js';
import { createProfileActions } from './hooks/profileActions.js';
import { fit } from './text.js';
import { SessionsTab } from './tabs/SessionsTab.js';
import { ProfilesTab } from './tabs/ProfilesTab.js';
import { UsageTab } from './tabs/UsageTab.js';
import { DiagnosticsTab } from './tabs/DiagnosticsTab.js';
import { FormDialog, type Dialog, type Field } from './modals/FormDialog.js';
import {
  ActionMenu as ActionMenuView,
  type ActionMenuState as ActionMenu,
} from './modals/ActionMenu.js';
import { TextViewer } from './modals/TextViewer.js';
import { CommandPalette } from './CommandPalette.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import type { DiagnosticsReport } from '../diagnostics.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdin } from 'ink';
import { Command } from 'commander';
import {
  inventory,
  inventoryAccounts,
  providerUsage,
  profileInventory,
  usageTools,
  type UnifiedInventory,
} from '../../unified-inventory.js';
import { discoverNativeProfiles } from '../discovery.js';
import stringWidth from 'string-width';
import { cleanText } from '../../util.js';
import { managementRpc } from '../client.js';
import { managementSuggestions } from '../slash.js';
import { nativeArguments } from '../arguments.js';
import { observerConfiguration, registerManagementCommands } from '../commands.js';
import { parseProfileLabel, type Snapshot, type SessionEntry, type Tool, type Profile } from '../model.js';
import {
  launchAgent,
  latestInvocation,
  loginProfile,
  resumeEntry,
  reopenEntry,
} from '../launcher.js';
import { flattenTree, folderPath, invocationLabel, type TreeRow } from '../tree.js';

type InputKey = Parameters<Parameters<typeof useInput>[0]>[1];

const globalCommandHistory: string[] = [
  '/usage',
  '/profiles',
  '/launch agy',
  '/swap --best',
  '/sessions',
  '/doctor',
];

function ManagementDashboard({
  handoff,
  notice,
  initialTab,
  initialDirectory,
  initialProfileTool,
  initialProfileId,
}: {
  handoff: (request: Handoff) => void;
  notice: string;
  initialTab: number;
  initialDirectory: string;
  initialProfileTool: number;
  initialProfileId: string | null;
}) {
  const { exit } = useApp();
  const size = useTerminalSize();
  const { snapshot, setSnapshot } = useManagementSnapshot({
    initial: (value) => {
      first.current = false;
      setExpanded(new Set(value.ui.expanded));
      setSelected(value.ui.selected);
    },
    update: (value) =>
      setUsage((current) =>
        current && current.native?.seq !== value.seq
          ? { ...current, native: value }
          : current,
      ),
    error: (message) => setMessage(message),
  });
  const [tab, setTab] = useState(initialTab);
  const [usage, setUsage] = useState<UnifiedInventory | null>(null);
  const [usageTool, setUsageTool] = useState(0);
  const [profileTool, setProfileTool] = useState(initialProfileTool);
  const selectedTool = usageTools[profileTool];
  const [usageOffset, setUsageOffset] = useState(0);
  const usageLines = useMemo(
    () =>
      providerUsage(
        usage ?? { native: snapshot, enrolled: [], warnings: [] },
        usageTools[usageTool].id,
        Math.max(20, size.width - 4),
      ),
    [usage, snapshot, usageTool, size.width],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [listIndex, setListIndex] = useState(0);
  const pendingProfileSelection = useRef(initialProfileId);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [commandDraft, setCommandDraft] = useState<string | null>(null);
  const commandInput = useRef<string | null>(null);
  const historyIndexRef = useRef(-1);
  const uncommittedDraftRef = useRef<string | null>(null);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const suggestionSelection = useRef(0);
  const suggestions = managementSuggestions(commandDraft ?? '');
  const suggestionPage = Math.min(4, suggestions.length);
  const suggestionStart = Math.max(0, suggestionIndex - suggestionPage + 1);
  function commandTo(value: string | null) {
    commandInput.current = value;
    setCommandDraft(value);
    suggestionSelection.current = 0;
    setSuggestionIndex(0);
  }
  const searchMode = useRef(false);
  const [archived, setArchived] = useState(false);
  const [message, setMessage] = useState(notice);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<ActionMenu | null>(null);
  const [viewer, setViewer] = useState<{ title: string; lines: string[]; offset: number } | null>(
    null,
  );
  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport | null>(null);
  const [historyCursors, setHistoryCursors] = useState<Record<string, string | null>>({});
  const first = useRef(true);
  const working = useRef(false);
  const current = useRef({ expanded, selected });
  current.current = { expanded, selected };
  async function inspectSupportedProfiles() {
    const profiles: Snapshot['profiles'] = await managementRpc('profiles.list');
    const supported = profiles.filter((p) => ['codex', 'copilot', 'claude'].includes(p.tool));
    for (let offset = 0; offset < supported.length; offset += 2) {
      await Promise.all(
        supported.slice(offset, offset + 2).map(async (profile) => {
          try {
            await managementRpc('profiles.inspect', { profile: profile.id });
          } catch {
            setMessage(
              'Native authentication status unavailable. Open /diagnostics for profile health.',
            );
          }
        }),
      );
    }
  }
  async function refreshUsage(refresh = false) {
    const value = await inventory({ refresh, nativeRefresh: refresh });
    setUsage(value);
    setMessage('Usage updated. See each provider for available balances.');
  }
  function selectTab(next: number) {
    setTab(next);
    setListIndex(0);
    setViewer(null);
    setMessage('');
    if (next === 2) void refreshUsage(false);
    else if (next === 1)
      void act(async () => {
        await discoverNativeProfiles();
        await inspectSupportedProfiles();
      });
  }
  async function submitCommand(text: string) {
    if (!text.startsWith('/'))
      throw new Error(
        'Use a management slash command, such as /usage. Principal does not execute tasks.',
      );
    const args = nativeArguments(text.slice(1));
    const name = args[0];
    if (['usage', 'resources', 'u'].includes(name)) {
      if (args.slice(1).some((a) => a !== '--refresh'))
        throw new Error('Use /usage or /usage --refresh');
      setTab(2);
      setUsageOffset(0);
      setViewer(null);
      await refreshUsage(args.includes('--refresh'));
    } else if (['pull', 'reopen'].includes(name)) {
      if (args.length > 2) throw new Error('Use /pull with a selected session, or /pull ENTRY_ID');
      const selected = args[1] ? snapshot?.entries.find((e) => e.id === args[1]) : entry;
      if (!selected) throw new Error('Select a session row in /sessions first, then use /pull.');
      await reopenForm(selected);
    } else if (name === 'accounts') {
      showText('Accounts', inventoryAccounts(await inventory({ inspect: true })).join('\n'));
    } else if (['sessions', 'dashboard', 'back', 's'].includes(name)) selectTab(0);
    else if (['profiles', 'p'].includes(name) && args.length === 1) {
      setTab(1);
      setListIndex(0);
      setViewer(null);
      const value = await inventory({ inspect: true });
      setUsage(value);
      if (value.native) setSnapshot(value.native);
    } else if (['doctor', 'diagnostics', 'd', 'doc', 'diag'].includes(name)) {
      setTab(3);
      setViewer(null);
      setDiagnostics(await managementRpc('diagnostics.report', {}, 120_000));
    } else if (['warnings', 'errors'].includes(name)) {
      openWarningsViewer();
      return;
    } else if (['exit', 'quit', 'q'].includes(name)) exit();
    else if (['help', 'h'].includes(name))
      showText(
        'Principal · Quick Commands & Guide',
        [
          'Essential Commands:',
          '  /launch (/l) [p1] [p2]... Launch one or multiple accounts in parallel',
          '  /swap   (/sw) [agy|cdx]   Hot swap active account (--best for max quota)',
          '  /usage  (/u) [--refresh]  Check token and quota balances across accounts',
          '  /profiles (/p)            Manage accounts & providers · n adds new login',
          '  /sessions (/s)            Browse and resume agent sessions and history',
          '  /doctor (/d)              Run system and native tool diagnostics',
          '  /exit   (/q)              Close Principal',
          '',
          'Shell-like Navigation:',
          '  ↑ / ↓       Recall previous command history in prompt (like Linux shell)',
          '  Tab         Autocomplete commands and cycle through suggestions',
          '  Space/Enter Open quick actions on any selected session or profile',
          '  q           Quit current view or exit',
        ].join('\n'),
      );
    else if (['profiles', 'p', 'folders', 'agents', 'launch', 'l', 'swap', 'switch', 'sw', 'export', 'exp', 'handoff', 'ho'].includes(name)) {
      if (name === 'profiles' && args[1] === 'login' && args.length === 3) {
        const current: Snapshot = await managementRpc('snapshot');
        const target = current.profiles.find((p) => p.id === args[2] || p.label === args[2]);
        if (target?.tool === 'antigravity') {
          setTab(1);
          setProfileTool(usageTools.findIndex((tool) => tool.id === 'antigravity'));
          setViewer(null);
          antigravitySignIn(target, true);
          return;
        }
      }
      const command = new Command()
        .enablePositionalOptions()
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} });
      registerManagementCommands(command, {
        directory: initialDirectory,
        print: (_command, value) =>
          showText(
            'Management result',
            typeof value === 'string' ? value : JSON.stringify(value, null, 2),
          ),
        runNative: async (run) => {
          await leave({ kind: 'operation', run });
        },
      });
      await command.parseAsync(args, { from: 'user' });
    } else
      throw new Error('Management-only application: use /help. Task execution is not available.');
  }
  function focus(id: string | null) {
    current.current.selected = id;
    setSelected(id);
  }
  function searchModeTo(value: boolean) {
    searchMode.current = value;
    setSearching(value);
  }
  useEffect(() => {
    if (first.current) return;
    const timer = setTimeout(() => {
      void managementRpc('ui.save', { expanded: [...expanded], selected }).catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [expanded, selected]);
  const rows = useMemo(
    () => (snapshot ? flattenTree(snapshot, expanded, search, archived) : []),
    [snapshot, expanded, search, archived],
  );
  const row = rows.find((item) => item.id === selected) ?? rows[0];
  const index = row ? rows.findIndex((item) => item.id === row.id) : 0;
  const entry = snapshot?.entries.find((item) => item.id === row?.entryId);
  const invocation = entry && snapshot ? latestInvocation(entry, snapshot.invocations) : undefined;
  const project = snapshot?.projects.find((item) => item.id === row?.projectId);
  const profileRows = useMemo(
    () =>
      profileInventory({
        native: snapshot,
        enrolled: usage?.enrolled ?? [],
        warnings: [],
      }).filter((p) => p.tool === selectedTool.id),
    [snapshot, usage?.enrolled, selectedTool.id],
  );
  const selectedProfileRow = profileRows[Math.min(listIndex, Math.max(0, profileRows.length - 1))];
  const profile = selectedProfileRow?.nativeProfile;
  useEffect(() => {
    if (!pendingProfileSelection.current) return;
    const target = profileRows.findIndex(
      (p) => p.nativeProfile?.id === pendingProfileSelection.current,
    );
    if (target >= 0) {
      pendingProfileSelection.current = null;
      setListIndex(target);
    }
  }, [snapshot, profileTool, usage]);
  async function act(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      await action();
      setSnapshot(await managementRpc('snapshot'));
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function leave(request: Handoff) {
    await managementRpc('ui.save', {
      expanded: [...current.current.expanded],
      selected: current.current.selected,
    });
    handoff({
      ...request,
      returnTab: tab,
      profileTool,
      profileId: request.kind === 'login' ? request.id : profile?.id,
    });
    exit();
  }
  function form(title: string, fields: Field[], submit: Dialog['submit'], description?: string[]) {
    setDialog({ title, fields, index: 0, submit, description });
  }
  function exportContextForm(selectedEntry: SessionEntry) {
    form(
      `Export Context · ${selectedEntry.title}`,
      [
        {
          label: 'Destination assistant',
          value: 'antigravity',
          choices: ['antigravity', 'claude', 'copilot'],
        },
        {
          label: 'Copy prompt to clipboard?',
          value: 'yes',
          choices: ['yes', 'no'],
        },
        {
          label: 'Save handoff markdown file?',
          value: 'yes',
          choices: ['yes', 'no'],
        },
        {
          label: 'Launch assistant immediately?',
          value: 'no',
          choices: ['no', 'yes'],
        },
      ],
      async ([dest, clip, saveFile, launchNow]) => {
        const result: any = await managementRpc(
          'context.export',
          {
            entryId: selectedEntry.id,
            targetTool: dest,
            saveToFile: saveFile === 'yes',
            copyToClipboard: clip === 'yes',
          },
          60_000,
        );

        if (launchNow === 'yes') {
          leave({
            kind: 'launch',
            options: {
              tool: dest as Tool,
              directory: result.directory,
              args: [result.summaryPrompt],
            },
          });
          return;
        }

        const lines = [
          `🔄 Context Handoff Generated:`,
          `  Session:     ${result.title}`,
          `  Native ID:   ${result.nativeId}`,
          `  Directory:   ${result.directory}`,
          `  Turns:       ${result.totalTurns}`,
        ];
        if (result.savedPath) lines.push(`  Saved To:    ${result.savedPath}`);
        if (result.copiedToClipboard) lines.push(`  Clipboard:   Prompt copied to system clipboard!`);
        lines.push('', '--- Recommended Seed Prompt ---', result.summaryPrompt);

        showText('Context Export Handoff', lines.join('\n'));
        setMessage(
          `Exported session to ${result.savedPath ?? 'memory'}${result.copiedToClipboard ? ' (prompt in clipboard)' : ''}.`,
        );
      },
      [
        'Transfers active work context from Codex to Antigravity when quota limits are reached.',
        'Extracts objectives, modified files, recent commands, and latest state into a clean handoff document.',
      ],
    );
  }
  function handoffExportForm(selectedProfile: Profile) {
    form(
      `Share Account (Handoff Code) · ${selectedProfile.label}`,
      [
        {
          label: 'Passphrase (optional, empty = open sharing)',
          value: '',
        },
        {
          label: 'Time limit (optional, e.g. 4h, 12h, 1d)',
          value: '',
        },
        {
          label: 'Quota limit % of weekly quota (optional, e.g. 20)',
          value: '',
        },
        {
          label: 'Label for recipient',
          value: `shared-${selectedProfile.tool}`,
        },
        {
          label: 'Copy to clipboard?',
          value: 'yes',
          choices: ['yes', 'no'],
        },
      ],
      async ([passphrase, timeLimit, quotaLimit, label, clip]) => {
        const result: any = await managementRpc('handoff.export', {
          profile: selectedProfile.id,
          passphrase: passphrase.trim() || undefined,
          timeLimit: timeLimit.trim() || undefined,
          quotaLimit: quotaLimit.trim() || undefined,
          label: label.trim() || undefined,
          copyToClipboard: clip === 'yes',
        });

        const lines = [
          `🔐 Scoped Account Handoff Generated:`,
          `  Tool:         ${result.tool}`,
          `  Profile:      ${result.profileLabel}`,
          `  Account Hint: ${result.accountHint}`,
        ];
        if (result.constraints?.timeLimitHours !== undefined || result.constraints?.expiresAt) {
          lines.push(
            `  Time Limit:   ${result.constraints.timeLimitHours ?? 'N'} hours (Expires: ${new Date(result.constraints.expiresAt).toLocaleString()})`,
          );
        }
        if (result.constraints?.quotaLimitPercent !== undefined) {
          lines.push(
            `  Quota Limit:  Max ${result.constraints.quotaLimitPercent}% of weekly limit (Cutoff Floor: ${result.constraints.allowedQuotaFloor?.toFixed(1) ?? 'N'}%)`,
          );
        }
        if (result.copiedToClipboard) {
          lines.push(`  Clipboard:    Handoff code copied to clipboard! (Ready to paste/send)`);
        }
        lines.push(
          '',
          '--- Handoff Code for Recipient ---',
          result.armoredToken,
          '',
          '🔒 Security Guarantees:',
          '  • Scoped strictly to assistant CLI API. Zero Google/OpenAI passwords or browser cookies.',
          '  • Recipient cannot access your Gmail, Google Drive, Photos, or OpenAI web billing.',
          '  • Constraints are cryptographically locked: friend cannot alter time or quota limit.',
          '  • You can revoke access anytime at: https://myaccount.google.com/permissions',
          '',
          'Recipient can import inside Principal:',
          `  Press 'Y' in /profiles, or run: principal handoff import "${result.armoredToken}"`,
        );

        showText('Account Handoff Code', lines.join('\n'));
        setMessage(
          `Handoff code generated for ${selectedProfile.label}${result.copiedToClipboard ? ' (copied to clipboard)' : ''}.`,
        );
      },
      [
        'Shares this account’s unused quota with a friend without exposing Google/OpenAI passwords.',
        'Recipient gets isolated CLI access only; Google Account and personal data remain 100% private.',
      ],
    );
  }
  function handoffImportForm() {
    form(
      'Import Shared Account Handoff',
      [
        {
          label: 'Handoff Code or file path',
          value: '',
        },
        {
          label: 'Passphrase (if set by owner, else empty)',
          value: '',
        },
        {
          label: 'Custom profile label (optional)',
          value: '',
        },
      ],
      async ([data, passphrase, label]) => {
        if (!data.trim()) throw new Error('Enter a valid handoff code or file path');
        const result: any = await managementRpc('handoff.import', {
          data: data.trim(),
          passphrase: passphrase.trim() || undefined,
          label: label.trim() || undefined,
        });

        setMessage(`[✓] Imported shared ${result.tool} account '${result.label}' (${result.accountHint})!`);
        setSnapshot(await managementRpc('snapshot'));
      },
      [
        'Imports a scoped account handoff code shared by a friend into an isolated profile sandbox.',
        'Zero conflicts with your existing accounts. Ready to launch or swap immediately.',
      ],
    );
  }
  function toggle(item: TreeRow) {
    focus(item.id);
    setExpanded((old) => {
      const next = new Set(old);
      next.has(item.id) ? next.delete(item.id) : next.add(item.id);
      return next;
    });
  }
  function reveal(folderId: string, value: Snapshot, projectId?: string) {
    const ids: string[] = [];
    let id: string | null = folderId;
    while (id) {
      ids.push(`f:${id}`);
      id = value.folders.find((f) => f.id === id)?.parentId ?? null;
    }
    if (projectId) ids.push(`p:${folderId}:${projectId}`);
    setExpanded((old) => new Set([...old, ...ids]));
  }
  const activeWarnings = useMemo(
    () =>
      Array.from(
        new Set([
          ...(usage?.warnings ?? []),
          ...(snapshot?.profiles.flatMap((p) => [
            ...(p.observationWarnings ?? []).map((w) => `${p.tool} (${p.label}): ${w}`),
            ...(p.observationError ? [`${p.tool} (${p.label}): ${p.observationError.reason}`] : []),
          ]) ?? []),
        ]),
      ).filter(Boolean),
    [usage?.warnings, snapshot?.profiles],
  );
  const activeWarningsRef = useRef(activeWarnings);
  activeWarningsRef.current = activeWarnings;
  function openWarningsViewer() {
    if (!activeWarningsRef.current.length) {
      setMessage('No active warnings or errors recorded.');
      return;
    }
    showText(
      `Warnings & Diagnostics (${activeWarningsRef.current.length})`,
      activeWarningsRef.current.map((w, i) => `${i + 1}. ${w}`).join('\n\n'),
    );
  }
  const openWarningsRef = useRef(openWarningsViewer);
  openWarningsRef.current = openWarningsViewer;
  const { stdin } = useStdin();
  useEffect(() => {
    const onData = (data: Buffer | string) => {
      const s = data.toString();
      if (s === '\x1bOQ' || s === '\x1b[12~' || s === '\x1b[[B') {
        openWarningsRef.current();
      }
    };
    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
    };
  }, [stdin]);
  function showText(title: string, text: string) {
    const lines = text.split('\n').flatMap((line) => {
      const chunks: string[] = [];
      let current = '';
      for (const char of cleanText(line)) {
        if (stringWidth(current + char) > Math.max(12, size.width - 10)) {
          chunks.push(current);
          current = '';
        }
        current += char;
      }
      return [...chunks, current];
    });
    setViewer({ title, lines, offset: 0 });
  }
  function openActions() {
    const items =
      tab === 0
        ? [
            { label: 'Launch an agent', key: 'n' },
            { label: 'Create a folder', key: 'c' },
            ...(entry
              ? [
                  { label: 'View session details', key: 'e' },
                  ...(entry.profileId
                    ? [
                        { label: 'Reopen on this terminal…', key: 'P' },
                        { label: 'Resume conversation', key: 'R' },
                      ]
                    : []),
                  ...(['codex', 'antigravity'].includes(entry.tool) && entry.conversationId
                    ? [{ label: 'Copy conversation to another profile', key: 'C' }]
                    : []),
                  ...(entry.tool === 'codex'
                    ? [{ label: 'Export context to Antigravity (handoff)', key: 'E' }]
                    : []),
                  { label: 'Rename session', key: 'r' },
                  { label: 'Move session', key: 'm' },
                  { label: entry.archivedAt ? 'Unarchive session' : 'Archive session', key: 'a' },
                  ...(invocation?.owned && invocation.lifecycle !== 'exited'
                    ? [{ label: 'Stop running agent…', key: 'x' }]
                    : []),
                ]
              : row?.kind === 'folder' && row.folderId !== 'unassigned'
                ? [
                    { label: 'Rename folder', key: 'r' },
                    { label: 'Move folder', key: 'm' },
                    { label: 'Change folder order', key: 'b' },
                    ...(row.count === 0 ? [{ label: 'Delete empty folder', key: 'd' }] : []),
                  ]
                : []),
            { label: archived ? 'Show visible sessions' : 'Show archived sessions', key: 'A' },
            { label: 'Search sessions', key: 'f' },
          ]
        : tab === 1
          ? [
              { label: 'Add account / sign in', key: 'n' },
              ...(profile
                ? [
                    { label: 'Check authentication', key: 'i' },
                    {
                      label:
                        profile.tool === 'antigravity'
                          ? 'Antigravity sign-in options…'
                          : 'Sign in using native tool',
                      key: 'l',
                    },
                    ...(profile.tool === 'codex'
                      ? [
                          { label: 'Sign in with device code', key: 'D' },
                          { label: 'Load existing Codex history', key: 'I' },
                        ]
                      : []),
                    ...(profile.tool === 'antigravity'
                      ? [{ label: 'Load existing Antigravity history (experimental)', key: 'I' }]
                      : []),
                    { label: 'Jump to current run…', key: 'P' },
                    { label: 'Launch native tool with this profile', key: 's' },
                    { label: 'Set as active profile (Hot Swap)', key: 'S' },
                    { label: 'Show this profile’s conversation history', key: 'h' },
                    { label: 'View profile details', key: 'e' },
                    { label: 'Rename profile', key: 'r' },
                    { label: 'Remove profile…', key: 'd' },
                    ...(profile && ['antigravity', 'codex'].includes(profile.tool)
                      ? [{ label: 'Share account with friend (Handoff code)…', key: 'W' }]
                      : []),
                    ...(historyCursors[profile.id]
                      ? [{ label: 'Import next history page', key: 'H' }]
                      : []),
                    ...(snapshot?.installations.find((i) => i.tool === profile.tool)?.capabilities
                      .observer.supported
                      ? [{ label: 'View optional observer setup', key: 'o' }]
                      : []),
                  ]
                : selectedProfileRow
                  ? [{ label: 'View account/session details', key: 'e' }]
                  : []),
              { label: 'Use an existing native login', key: 'a' },
              { label: 'Advanced profile setup', key: 'N' },
              { label: 'Import shared account handoff code…', key: 'Y' },
            ]
          : tab === 2
            ? [{ label: 'Refresh resource observations', key: 'u' }]
            : [{ label: 'Recheck installed tools', key: 'v' }];
    setMenu({
      title: ['Session actions', 'Profile actions', 'Resource actions', 'Diagnostics actions'][tab],
      items,
      index: 0,
    });
  }
  function switchProvider(backwards = false) {
    const update = (old: number) =>
      (old + (backwards ? usageTools.length - 1 : 1)) % usageTools.length;
    if (tab === 1) {
      setProfileTool(update);
      setListIndex(0);
    } else {
      setUsageTool(update);
      setUsageOffset(0);
    }
    setMessage('');
  }
  function handleInput(input: string, key: InputKey, fromMenu = false) {
    // Input can arrive faster than a render. Navigation and search transitions
    // use the latest cursor/mode, avoiding dropped adjacent key events.
    const row = rows.find((item) => item.id === current.current.selected) ?? rows[0];
    const index = row ? rows.findIndex((item) => item.id === row.id) : 0;
    const entry = snapshot?.entries.find((item) => item.id === row?.entryId);
    const invocation =
      entry && snapshot ? latestInvocation(entry, snapshot.invocations) : undefined;
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    if (input === '\x1bOQ' || input === '\x1b[12~' || input === '\x1b[[B') {
      openWarningsViewer();
      return;
    }
    if (commandInput.current !== null) {
      const choices = managementSuggestions(commandInput.current);
      if (key.escape) {
        historyIndexRef.current = -1;
        uncommittedDraftRef.current = null;
        commandTo(null);
      } else if (key.upArrow) {
        if (historyIndexRef.current === -1) {
          uncommittedDraftRef.current = commandInput.current;
        }
        if (
          globalCommandHistory.length > 0 &&
          historyIndexRef.current < globalCommandHistory.length - 1
        ) {
          historyIndexRef.current++;
          const recalled =
            globalCommandHistory[globalCommandHistory.length - 1 - historyIndexRef.current];
          commandTo(recalled);
        }
      } else if (key.downArrow) {
        if (historyIndexRef.current > 0) {
          historyIndexRef.current--;
          const recalled =
            globalCommandHistory[globalCommandHistory.length - 1 - historyIndexRef.current];
          commandTo(recalled);
        } else if (historyIndexRef.current === 0) {
          historyIndexRef.current = -1;
          commandTo(uncommittedDraftRef.current ?? '');
        } else if (choices.length) {
          const next = (suggestionSelection.current + 1) % choices.length;
          suggestionSelection.current = next;
          setSuggestionIndex(next);
        }
      } else if (key.tab && choices.length) {
        if (key.shift) {
          const prev = (suggestionSelection.current - 1 + choices.length) % choices.length;
          suggestionSelection.current = prev;
          setSuggestionIndex(prev);
          commandTo(choices[prev]?.command + ' ');
        } else {
          const currentChoice = choices[suggestionSelection.current]?.command;
          if (
            currentChoice &&
            commandInput.current !== currentChoice &&
            commandInput.current !== currentChoice + ' '
          ) {
            commandTo(currentChoice + ' ');
          } else {
            const next = (suggestionSelection.current + 1) % choices.length;
            suggestionSelection.current = next;
            setSuggestionIndex(next);
            commandTo(choices[next]?.command + ' ');
          }
        }
      } else if (key.return) {
        const typed = commandInput.current.trim();
        const exact = choices.some((c) => c.command === typed);
        const text =
          !exact && choices.length && !typed.includes(' ')
            ? choices[suggestionSelection.current].command
            : typed;
        if (['/exit', '/quit', '/q'].includes(text)) {
          exit();
          return;
        }
        if (text) {
          if (
            !globalCommandHistory.length ||
            globalCommandHistory[globalCommandHistory.length - 1] !== text
          ) {
            globalCommandHistory.push(text);
          }
        }
        historyIndexRef.current = -1;
        uncommittedDraftRef.current = null;
        if (busy) {
          const views: Record<string, number> = {
            '/sessions': 0,
            '/dashboard': 0,
            '/back': 0,
            '/s': 0,
            '/profiles': 1,
            '/p': 1,
            '/usage': 2,
            '/usage --refresh': 2,
            '/u': 2,
            '/doctor': 3,
            '/diagnostics': 3,
            '/d': 3,
          };
          if (views[text] !== undefined) {
            commandTo(null);
            setTab(views[text]);
            setViewer(null);
            setListIndex(0);
            setUsageOffset(0);
            setMessage('View switched; current observations are still loading.');
          } else setMessage('Observations are loading; press Enter when ready.');
          return;
        }
        commandTo(null);
        if (text) void act(() => submitCommand(text));
      } else if (key.backspace || key.delete) {
        historyIndexRef.current = -1;
        commandTo([...commandInput.current].slice(0, -1).join(''));
      } else if (!key.ctrl && !key.meta && input) {
        historyIndexRef.current = -1;
        commandTo((commandInput.current + cleanText(input)).slice(0, 4096));
      }
      return;
    }
    if (!dialog && !menu && !searchMode.current && input.startsWith('/')) {
      setViewer(null);
      commandTo(input);
      return;
    }
    if (busy) {
      // Provider switching stays responsive while observations load.
      if (
        (tab === 1 || tab === 2) &&
        key.tab &&
        commandInput.current === null &&
        !dialog &&
        !menu &&
        !viewer
      )
        switchProvider(key.shift);
      return;
    }
    if (viewer) {
      if (key.escape || key.return || input === 'q') setViewer(null);
      else if (key.downArrow || input === 'j')
        setViewer({
          ...viewer,
          offset: Math.min(Math.max(0, viewer.lines.length - 1), viewer.offset + 1),
        });
      else if (key.upArrow || input === 'k')
        setViewer({ ...viewer, offset: Math.max(0, viewer.offset - 1) });
      return;
    }
    if (menu && !fromMenu) {
      if (key.escape || input === 'q') setMenu(null);
      else if (key.downArrow || input === 'j' || key.upArrow || input === 'k')
        setMenu({
          ...menu,
          index:
            (menu.index + (key.upArrow || input === 'k' ? menu.items.length - 1 : 1)) %
            menu.items.length,
        });
      else if (key.return) {
        const action = menu.items[menu.index];
        setMenu(null);
        handleInput(action.key, {} as InputKey, true);
      }
      return;
    }
    if (dialog) {
      if (key.escape) {
        setDialog(null);
        return;
      }
      if (dialog.fields.length && (key.tab || key.downArrow || key.upArrow)) {
        setDialog({
          ...dialog,
          index:
            (dialog.index + (key.upArrow || key.shift ? dialog.fields.length - 1 : 1)) %
            dialog.fields.length,
        });
        return;
      }
      if (key.return) {
        const values = dialog.fields.map((f) => f.value);
        const labelIndex = dialog.fields.findIndex((f) =>
          ['Unique label', 'Profile name'].includes(f.label),
        );
        if (labelIndex >= 0) {
          try {
            parseProfileLabel(values[labelIndex]);
          } catch (error) {
            setMessage((error as Error).message);
            setDialog({ ...dialog, index: labelIndex });
            return;
          }
        }
        const submit = dialog.submit;
        void act(async () => {
          await submit(values);
          setDialog((current) => (current === dialog ? null : current));
        });
        return;
      }
      const field = dialog.fields[dialog.index];
      if (!field) return;
      if (field.choices) {
        if (key.leftArrow || key.rightArrow) {
          const direction = key.leftArrow ? -1 : 1;
          const value =
            field.choices[
              (field.choices.indexOf(field.value) + direction + field.choices.length) %
                field.choices.length
            ];
          setDialog({
            ...dialog,
            fields: dialog.fields.map((f, i) => (i === dialog.index ? { ...f, value } : f)),
          });
        }
        return;
      }
      if (key.ctrl && input === 'u') {
        setDialog(
          (current) =>
            current && {
              ...current,
              fields: current.fields.map((f, i) => (i === current.index ? { ...f, value: '' } : f)),
            },
        );
        return;
      }
      if (key.backspace || key.delete) {
        setDialog({
          ...dialog,
          fields: dialog.fields.map((f, i) =>
            i === dialog.index ? { ...f, value: [...f.value].slice(0, -1).join('') } : f,
          ),
        });
        return;
      }
      if (!key.ctrl && !key.meta && input)
        setDialog({
          ...dialog,
          fields: dialog.fields.map((f, i) =>
            i === dialog.index ? { ...f, value: (f.value + cleanText(input)).slice(0, 4096) } : f,
          ),
        });
      return;
    }
    if (searchMode.current) {
      if (key.return || key.escape) {
        searchModeTo(false);
        if (key.escape) setSearch('');
        return;
      }
      if (key.backspace || key.delete) setSearch((value) => [...value].slice(0, -1).join(''));
      else if (!key.ctrl && input) setSearch((value) => (value + cleanText(input)).slice(0, 160));
      return;
    }
    if (input === 'q') {
      void managementRpc('ui.save', { expanded: [...expanded], selected }).finally(exit);
      return;
    }
    if (key.escape) {
      setSearch('');
      return;
    }
    if (key.tab) {
      if (tab === 1 || tab === 2) switchProvider(key.shift);
      return;
    }
    if (input === '?') {
      setMessage(
        'Sessions: n launch · c folder · C copy Codex conversation to another profile · m move · r rename · a archive · A archived · P reopen here · R resume · x stop · d delete empty folder · f search. Profiles: Tab switches providers · n add account/sign in · a existing login · N advanced setup · r rename · d remove · l sign in · P jump to current run · s launch native tool · i check auth · h show profile history · I load native Codex history. Usage: Tab switches tools · u refresh. Use /sessions, /profiles, /usage, /diagnostics to switch views. Space opens actions; q quits Principal.',
      );
      return;
    }
    if (input === 'u') {
      void act(() => refreshUsage(true));
      return;
    }
    if (input === 'w') {
      openWarningsViewer();
      return;
    }
    if (!snapshot) return;
    if (input === ' ' || (key.return && tab !== 0)) {
      openActions();
      return;
    }
    if (input === 'v' && tab === 3) {
      void act(async () => {
        setDiagnostics(await managementRpc('diagnostics.report', {}, 120_000));
        setMessage('Installed tools rechecked.');
      });
      return;
    }
    if (tab === 0) {
      if (input === 'f' || (key.ctrl && input === 'f')) {
        searchModeTo(true);
        return;
      }
      if (key.escape) {
        setSearch('');
        return;
      }
      if (input === 'A') {
        setArchived((value) => !value);
        return;
      }
      if (key.downArrow || input === 'j' || key.upArrow || input === 'k') {
        focus(
          rows[
            Math.max(0, Math.min(rows.length - 1, index + (key.upArrow || input === 'k' ? -1 : 1)))
          ]?.id ?? null,
        );
        return;
      }
      if (row && (key.rightArrow || key.return)) {
        if (row.kind !== 'entry' && key.rightArrow && row.expanded) {
          const child = rows[index + 1];
          if (child?.parent === row.id) focus(child.id);
        } else if (row.kind !== 'entry' && !search) toggle(row);
        else if (key.return) openActions();
        return;
      }
      if (row && key.leftArrow) {
        if (row.kind !== 'entry' && expanded.has(row.id)) toggle(row);
        else if (row.parent) focus(row.parent);
        return;
      }
      if (entry && input === 'e') showText('Session details', detailLines.join('\n'));
      if (input === 'n') launchForm();
      if (input === 'c')
        form(
          'Create nested folder',
          [
            {
              label: 'Folder path',
              value: row ? `${folderPath(row.folderId, snapshot.folders)}/` : '',
            },
          ],
          async ([path]) => {
            const folder = await managementRpc('folders.create', { path });
            focus(`f:${folder.id}`);
            reveal(folder.id, await managementRpc('snapshot'));
          },
        );
      if (row && input === 'r' && row.kind !== 'project')
        form(
          'Rename selected item',
          [{ label: 'Name', value: entry?.title ?? row.label }],
          async ([name]) => {
            await managementRpc(
              entry ? 'entries.update' : 'folders.update',
              entry ? { id: entry.id, title: name } : { id: row.folderId, name },
            );
          },
        );
      if (row && input === 'm' && row.kind !== 'project')
        form(
          'Move selected item',
          [
            {
              label: entry
                ? 'Destination folder path / ID'
                : 'Parent folder path / ID (empty = root)',
              value: '',
            },
          ],
          async ([folder]) => {
            const updated = await managementRpc(
              entry ? 'entries.update' : 'folders.update',
              entry ? { id: entry.id, folder } : { id: row.folderId, parent: folder || null },
            );
            reveal(
              entry ? updated.folderId : updated.id,
              await managementRpc('snapshot'),
              entry?.projectId,
            );
            setSearch('');
          },
        );
      if (entry && input === 'a')
        void act(async () => {
          await managementRpc('entries.update', { id: entry.id, archived: !entry.archivedAt });
          setMessage('Visibility updated; no files, native history, or processes changed');
        });
      if (entry && input === 'P') void act(() => reopenForm(entry));
      if (entry && input === 'R') {
        const conversation = snapshot.conversations.find((c) => c.id === entry.conversationId);
        if (conversation?.nativeResumeVerified === false)
          form(
            'Try native resume · experimental Antigravity copy',
            [],
            async () => leave({ kind: 'resume', id: entry.id, experimentalHistory: true }),
            [
              'Local history was copied successfully, but native cross-account continuation is unverified.',
              'Native IDs and workspace were retained. The native tool may reject or reinterpret this history.',
              'No inference prompt is sent by Principal. Exit the native tool to return.',
            ],
          );
        else void act(() => leave({ kind: 'resume', id: entry.id }));
      }
      if (entry && input === 'C' && entry.tool === 'antigravity') {
        copyAntigravityForm(entry);
        return;
      }
      if (entry && input === 'C') {
        const targets = snapshot.profiles.filter(
          (p) => p.tool === 'codex' && p.id !== entry.profileId,
        );
        if (entry.tool !== 'codex' || !entry.conversationId) {
          setMessage('Import a Codex conversation first: /profiles → select profile → h.');
        } else if (!targets.length) {
          setMessage('Add a second Codex profile first: /profiles → Codex → n.');
        } else
          form(
            'Copy complete saved conversation · independent history, destination login preserved',
            [
              {
                label: 'Destination profile',
                value: targets[0]!.label,
                choices: targets.map((p) => p.label),
              },
              {
                label: 'Project directory (use a separate worktree for independent edits)',
                value: project?.directory ?? initialDirectory,
              },
              { label: 'Conversation name', value: `${entry.title.slice(0, 150)} (copy)` },
            ],
            async ([label, directory, title]) => {
              const target = targets.find((p) => p.label === label)!;
              const result = await managementRpc(
                'history.copy',
                {
                  entry: entry.id,
                  targetProfile: target.id,
                  directory,
                  title,
                },
                90_000,
              );
              const latest = await managementRpc('snapshot');
              reveal(result.entry.folderId, latest, result.entry.projectId);
              setSearch('');
              focus(`e:${result.entry.id}`);
              setMessage(
                'Conversation copied with a new ID. Select the copy and press Shift+R to resume with its destination profile.',
              );
            },
          );
      }
      if (entry && entry.tool === 'codex' && (input === 'E' || (input === 'e' && key.shift))) {
        exportContextForm(entry);
        return;
      }
      if (invocation && input === 'x')
        form(
          'Stop owned invocation',
          [{ label: 'Type stop to send SIGTERM to this invocation', value: '' }],
          async ([confirmation]) => {
            if (confirmation !== 'stop') throw new Error('Stop canceled');
            await managementRpc('invocations.stop', { id: invocation.id });
            setMessage('Stop requested; exit remains subject to process reconciliation');
          },
        );
      if (row?.kind === 'folder' && input === 'b')
        form(
          'Change folder order',
          [
            {
              label: 'Position (0 = first)',
              value: String(snapshot.folders.find((f) => f.id === row.folderId)?.order ?? 0),
            },
          ],
          async ([value]) => {
            if (!/^\d+$/.test(value)) throw new Error('Enter a nonnegative whole number');
            await managementRpc('folders.update', { id: row.folderId, order: Number(value) });
          },
        );
      if (row?.kind === 'folder' && input === 'd')
        void act(async () => {
          await managementRpc('folders.delete', { id: row.folderId });
          focus(null);
        });
    } else if (tab === 1) {
      if (key.downArrow || input === 'j')
        setListIndex((old) => Math.min(Math.max(0, profileRows.length - 1), old + 1));
      if (key.upArrow || input === 'k') setListIndex((old) => Math.max(0, old - 1));
      if (input === 'n') addAccount();
      if (input === 'a') addAccount(true);
      if (input === 'Y' || input === 'y') {
        handoffImportForm();
        return;
      }
      if (input === 'N')
        form(
          'Add native profile (advanced) · login remains provider-owned',
          [
            {
              label: 'Provider',
              value: selectedTool.id,
              choices: ['codex', 'claude', 'copilot', 'antigravity'],
            },
            { label: 'Unique label', value: '' },
            {
              label: 'Configuration',
              value: 'Existing native login',
              choices: ['Existing native login', 'New isolated configuration'],
            },
            { label: 'Existing directory (optional)', value: '' },
          ],
          async ([tool, label, isolated, directory]) => {
            const added = await managementRpc('profiles.add', {
              tool,
              label,
              isolated: isolated === 'New isolated configuration',
              directory: directory || undefined,
            });
            setProfileTool(usageTools.findIndex((t) => t.id === added.tool));
            setListIndex(0);
            setMessage(
              'Profile registered. Existing logins need no new sign-in; choose Check authentication from the action menu.',
            );
          },
        );
      if (selectedProfileRow && input === 'e')
        showText('Account/session details', selectedProfileRow.detail.join('\n'));
      if (profile && input === 'r')
        form(
          'Rename profile',
          [{ label: 'Unique label', value: profile.label }],
          async ([label]) => {
            await managementRpc('profiles.rename', { profile: profile.id, label });
            setMessage('Profile renamed. Its login and sessions are preserved.');
          },
        );
      if (profile && input === 'd')
        form(
          'Remove profile · credentials and history are kept',
          [{ label: `Type remove to unregister ${profile.label}`, value: '' }],
          async ([confirmation]) => {
            if (confirmation !== 'remove')
              throw new Error('Type remove to confirm, or press Esc to cancel.');
            await managementRpc('profiles.remove', { profile: profile.id });
            setListIndex(0);
            setMessage(
              'Profile removed from Principal. Native credentials and history are kept; add its existing directory to restore it.',
            );
          },
        );
      if (profile && input === 'l') {
        if (profile.tool === 'antigravity') antigravitySignIn(profile, true);
        else void act(() => leave({ kind: 'login', id: profile.id }));
      }
      if (profile?.tool === 'codex' && input === 'D')
        void act(() => leave({ kind: 'login', id: profile.id, deviceAuth: true }));
      if (profile && input === 'P') void act(() => jumpProfile(profile));
      if (profile && input === 's') launchForm(profile.label);
      if (profile && input === 'S')
        void act(async () => {
          const result: any = await managementRpc('profiles.swap', {
            tool: profile.tool,
            target: profile.id,
          });
          const ambientMsg = result.ambientSync?.message ? ` (${result.ambientSync.message})` : '';
          setMessage(`Swapped active ${profile.tool} account to ${profile.label}${ambientMsg}`);
          setSnapshot(await managementRpc('snapshot'));
        });
      if (profile && input === 'i')
        void act(async () => {
          const result = await managementRpc('profiles.inspect', { profile: profile.id });
          setMessage(
            result.reason ??
              `${result.profile.label}: ${result.profile.auth} · ${result.profile.reportedAccount ?? 'account identity unavailable'}`,
          );
        });
      if (profile && ['antigravity', 'codex'].includes(profile.tool) && (input === 'W' || input === 'w')) {
        handoffExportForm(profile);
        return;
      }
      if (profile && input === 'o') {
        const recipe = observerConfiguration(profile);
        const text = `${recipe.note}\n\nSettings file: ${recipe.settingsFile}\n\n${JSON.stringify(recipe.merge, null, 2)}`;
        showText('Optional native observer · settings unchanged', text);
      }
      if (profile?.tool === 'antigravity' && input === 'I') loadAntigravityHistory(profile);
      if (profile?.tool === 'codex' && input === 'I')
        void act(async () => {
          const threads = new Map<
            string,
            { nativeId: string; title: string; alreadyLoaded: boolean }
          >();
          let sourceDirectory = '';
          for (const archived of [false, true]) {
            let cursor: string | undefined;
            const cursors = new Set<string>();
            do {
              const result = await managementRpc('history.native', {
                targetProfile: profile.id,
                archived,
                ...(cursor ? { cursor } : {}),
              });
              if (sourceDirectory && sourceDirectory !== result.sourceDirectory)
                throw new Error('Native history location changed. Try loading history again.');
              sourceDirectory = result.sourceDirectory;
              for (const thread of result.threads) threads.set(thread.nativeId, thread);
              cursor = result.nextCursor ?? undefined;
              if (cursor && (cursors.has(cursor) || cursors.size >= 100))
                throw new Error('Native history pagination did not finish; nothing was copied.');
              if (cursor) cursors.add(cursor);
              setMessage(`Found ${threads.size} existing Codex conversations…`);
            } while (cursor);
          }
          const pending = [...threads.values()].filter((t) => !t.alreadyLoaded);
          if (!pending.length) {
            setMessage(
              threads.size
                ? 'All native Codex conversations are already loaded into this profile.'
                : 'No saved conversations found in the native Codex history.',
            );
            return;
          }
          form(
            `Load existing Codex history · ${profile.label}`,
            [],
            async () => {
              let copied = 0;
              let alreadyLoaded = threads.size - pending.length;
              const failures: string[] = [];
              for (const [index, thread] of pending.entries()) {
                setMessage(
                  `Loading Codex history ${index + 1}/${pending.length} · ${copied} copied…`,
                );
                try {
                  const result = await managementRpc(
                    'history.seed',
                    {
                      targetProfile: profile.id,
                      sourceDirectory,
                      nativeId: thread.nativeId,
                    },
                    90_000,
                  );
                  if (result.alreadyLoaded) alreadyLoaded++;
                  else copied++;
                } catch (error) {
                  failures.push(`${thread.title}: ${(error as Error).message}`);
                }
              }
              const latest = await managementRpc('snapshot');
              for (const entry of latest.entries.filter(
                (e: Snapshot['entries'][number]) => e.profileId === profile.id,
              ))
                reveal(entry.folderId, latest, entry.projectId);
              const summary = `Loaded ${copied} conversations into ${profile.label}; ${alreadyLoaded} already loaded; ${failures.length} could not be copied.`;
              setMessage(`${summary} Open /sessions to resume or copy into another profile.`);
              if (failures.length)
                showText(
                  'History loading results',
                  `${summary}\n\n${failures.join('\n')}\n\nCompleted copies are kept. Finish active source turns and retry Load existing Codex history to copy the remaining conversations.`,
                );
            },
            [
              `${pending.length} conversations will be copied into ${profile.label}.`,
              `Source: ${sourceDirectory}`,
              'Your profile login is preserved. Each copy continues independently.',
              ...pending.slice(0, 3).map((t) => `· ${t.title}`),
              ...(pending.length > 3 ? [`· and ${pending.length - 3} more`] : []),
            ],
          );
        });
      if (profile && (input === 'h' || input === 'H'))
        void act(async () => {
          const result = await managementRpc('history.read', {
            profile: profile.id,
            ...(input === 'H' && historyCursors[profile.id]
              ? { cursor: historyCursors[profile.id] }
              : {}),
          });
          setHistoryCursors((old) => ({ ...old, [profile.id]: result.nextCursor ?? null }));
          setMessage(
            result.reason ??
              `Imported ${result.imported.length} history entries${result.nextCursor ? '; choose Import next history page for more' : '; history page complete'}`,
          );
        });
    } else if (tab === 2) {
      if (key.downArrow || input === 'j' || key.pageDown)
        setUsageOffset((old) =>
          Math.min(
            Math.max(0, usageLines.length - page + 2),
            old + (key.pageDown ? Math.max(1, page - 2) : 1),
          ),
        );
      if (key.upArrow || input === 'k' || key.pageUp)
        setUsageOffset((old) => Math.max(0, old - (key.pageUp ? Math.max(1, page - 2) : 1)));
    }
  }
  const inputHandler = useRef(handleInput);
  inputHandler.current = handleInput;
  useInput(useCallback((input, key) => inputHandler.current(input, key), []));
  const width = Math.max(20, size.width - 4);
  const page = Math.max(
    1,
    size.height - 12 - suggestionPage - (dialog ? dialog.fields.length + 4 : 0),
  );
  const usagePage = Math.max(
    1,
    size.height - 8 - suggestionPage - (dialog ? dialog.fields.length + 4 : 0),
  );
  const usageStart = Math.min(usageOffset, Math.max(0, usageLines.length - usagePage));
  const start = Math.max(0, index - page + 1);
  const wide = size.width >= 110;
  const listWidth = wide ? Math.floor(width * 0.55) : width;
  const selectedProfile =
    entry && snapshot ? snapshot.profiles.find((p) => p.id === entry.profileId) : undefined;
  const {
    addAccount,
    antigravitySignIn,
    loadAntigravityHistory,
    jumpProfile,
    reopenForm,
    copyAntigravityForm,
    launchForm,
  } = createProfileActions({
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
  });
  const detailLines = entry
    ? [
        entry.title,
        `Launch project: ${project?.directory ?? 'unknown'}`,
        `Tool: ${entry.tool}`,
        `Requested profile: ${selectedProfile?.label ?? 'unknown'}`,
        `Native-reported directory: ${invocation?.reportedDirectory ?? 'not observed'}`,
        `Reported process account: ${invocation?.reportedAccount ?? 'unknown'}`,
        `State: ${invocationLabel(invocation)}`,
        `Controlling terminal: ${invocation?.hasControllingTerminal === true ? 'present' : invocation?.hasControllingTerminal === false ? 'absent; the process can still exist without an open window' : 'not checked'}`,
        `Observation: ${invocation?.observedAt ?? 'none'}`,
        `Control: ${invocation?.owned ? 'owned launch' : 'observation only'}`,
        `Activity source: ${invocation?.activitySource ?? 'not observed'}`,
        `Native ID: ${snapshot?.conversations.find((c) => c.id === entry.conversationId)?.nativeId ?? 'not observed; native picker where supported'}`,
        `Entry ID: ${entry.id}`,
      ]
    : row?.kind === 'folder'
      ? [
          `${row.label} · ${row.count} entries`,
          'Virtual folder; filesystem and credentials are unaffected.',
        ]
      : project
        ? [project.name, project.directory]
        : ['Create a folder or launch an agent.'];
  const activeTabName = ['/sessions', '/profiles', '/usage', '/diagnostics'][tab];
  return (
    <Box flexDirection="column" paddingX={1} height={size.height}>
      <Text bold color="cyan">
        Principal · {snapshot?.environment.name ?? 'Connecting to management…'} ·{' '}
        {activeTabName}
        {busy ? ' · Working…' : ''}
      </Text>

      <Box flexDirection="column" flexGrow={1}>
        {!dialog && !menu && !viewer && tab === 0 && (
          <SessionsTab
            archived={archived}
            search={search}
            searching={searching}
            rows={rows}
            snapshot={snapshot}
            row={row}
            start={start}
            page={page}
            wide={wide}
            width={width}
            listWidth={listWidth}
            detailLines={detailLines}
          />
        )}
        {!dialog && !menu && !viewer && tab === 1 && (
          <ProfilesTab
            profileTool={profileTool}
            selectedTool={selectedTool}
            profileRows={profileRows}
            selectedProfileRow={selectedProfileRow}
            profile={profile}
            snapshot={snapshot}
            listIndex={listIndex}
            page={page}
            width={width}
          />
        )}
        {!dialog && !menu && !viewer && tab === 2 && (
          <UsageTab
            tool={usageTool}
            lines={usageLines}
            start={usageStart}
            page={usagePage}
            width={width}
          />
        )}
        {!dialog && !menu && !viewer && tab === 3 && (
          <DiagnosticsTab report={diagnostics} width={width} />
        )}
        {menu && <ActionMenuView menu={menu} width={width} height={size.height} />}
        {viewer && <TextViewer viewer={viewer} width={width} height={size.height} />}
        {dialog && <FormDialog dialog={dialog} width={width} />}
      </Box>

      <Box flexDirection="column">
        {!dialog && !menu && !viewer && (
          <CommandPalette
            suggestions={suggestions}
            start={suggestionStart}
            page={suggestionPage}
            index={suggestionIndex}
            draft={commandDraft}
            width={width}
          />
        )}
        <Text color={message ? (message.includes('Error') || message.includes('failed') ? 'red' : 'yellow') : 'gray'}>
          {fit(
            message ||
              (snapshot && !snapshot.profiles.length
                ? '💡 Start here: /profiles → Enter → Add existing login / new profile'
                : ''),
            width,
          )}
        </Text>
        <Box justifyContent="space-between" width={width}>
          <Text dimColor>
            {fit(
              commandDraft !== null
                ? '↑↓ history · Tab autocomplete · Enter run · Esc cancel'
                : tab === 1
                  ? 'Tab / Shift+Tab providers · ↑↓ accounts · / commands · q quit'
                  : tab === 2
                    ? 'Tab / Shift+Tab tools · ↑↓ scroll · u refresh · / commands · q quit'
                    : 'Space actions · Enter open · / commands · q quit',
              activeWarnings.length ? Math.max(10, width - 26) : width,
            )}
          </Text>
          {activeWarnings.length > 0 && (
            <Text color="yellow">
              ⚠ {activeWarnings.length} {activeWarnings.length === 1 ? 'warning' : 'warnings'} · <Text bold>f2</Text> to view
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}
export async function managementDashboard(
  initialTab = 2,
  initialDirectory = process.cwd(),
): Promise<void | { command: string }> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Principal requires an interactive terminal');
  let notice = '';
  let initialProfileTool = 0;
  let initialProfileId: string | null = null;
  for (;;) {
    let request: Handoff | null = null;
    const instance = render(
      <ManagementDashboard
        notice={notice}
        initialTab={initialTab}
        initialDirectory={initialDirectory}
        initialProfileTool={initialProfileTool}
        initialProfileId={initialProfileId}
        handoff={(value) => {
          request = value;
        }}
      />,
      { exitOnCtrlC: false },
    );
    await instance.waitUntilExit();
    instance.unmount();
    if (!request) return;
    // Assignment happens in an event callback, after render.
    const next = request as Handoff;
    initialTab = next.returnTab ?? initialTab;
    initialProfileTool = next.profileTool ?? initialProfileTool;
    initialProfileId = next.profileId ?? null;

    try {
      const code =
        next.kind === 'operation'
          ? await next.run()
          : next.kind === 'launch'
            ? await launchAgent(next.options)
            : next.kind === 'reopen'
              ? await reopenEntry(
                  next.id,
                  next.stopInvocationId,
                  next.experimentalHistory,
                  next.forceStop,
                )
              : next.kind === 'login'
                ? await loginProfile(next.id, next.deviceAuth)
                : await resumeEntry(next.id, next.experimentalHistory);
      notice =
        next.kind === 'login'
          ? `Native sign-in exited (${code}); returned to Profiles.`
          : `Native tool exited (${code}); management resumed.`;
      if (next.kind !== 'login' && code === 0) {
        const state: Snapshot = await managementRpc('snapshot');
        if (state.invocations.some((i) => i.owned && i.terminal && i.lifecycle !== 'exited'))
          notice =
            'Management resumed; persistent agents remain available through Jump to current run. Ctrl+b, then d detaches.';
      }
    } catch (error) {
      notice = (error as Error).message;
    }
  }
}
