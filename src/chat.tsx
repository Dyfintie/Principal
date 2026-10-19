import {
  moveViewport,
  viewportStart,
  mouseScroll,
  terminalInputOn,
  terminalInputOff,
} from './chat-scroll.js';
import { inputPreview } from './chat-input.js';
import { useEffect, useState, useRef } from 'react';
import { render, Box, Text, useInput, useApp, useStdout, useCursor } from 'ink';
import { rpc } from './client.js';
import { uid, cleanText } from './util.js';
import path from 'node:path';
import { ConfigSchema, type Config, type Provider } from './schema.js';
import { openNative } from './native-client.js';
import { enrollAccount } from './account-enrollment.js';
import { homedir } from 'node:os';
import {
  inventory,
  inventoryAccounts,
  inventoryUsage,
  type UnifiedInventory,
} from './unified-inventory.js';
import { executeTuiCommand } from './tui-command-router.js';
import { managementDashboard } from './management/dashboard.js';
import { managementRpc } from './management/client.js';
import { discoverNativeProfiles } from './management/discovery.js';
import { loginProfile, resumeEntry } from './management/launcher.js';
import { stat } from 'node:fs/promises';
import { normalizeTool } from './management/model.js';
import { chatCommands, commandSuggestions } from './chat-commands.js';
import type { Session, Message, Turn } from './session-types.js';
type Snapshot = {
  partial?: string;
  session: Session;
  leadAccountLabel?: string;
  messages: Message[];
  turns: Turn[];
  children: Session[];
  events: any[];
};
const help = chatCommands.map((c) => `${c.name}${c.args ? ' ' + c.args : ''}`).join(' · ');
type Preferences = { pool?: string; lead?: string; model?: string };
type Startup = {
  directory: string;
  notice?: string;
  create: (directory: string, preferences?: Preferences) => Promise<Session>;
  preferences?: Preferences;
  settings?: (directory?: string) => Promise<Config>;
};
type Enrollment = {
  provider: Provider;
  label?: string;
  sessionId?: string;
  directory?: string;
  preferences?: Preferences;
};
function Chat({
  initialId,
  startup,
  initialNotice,
  onEnroll,
  onNative,
  onOperation,
  initialCommand,
}: {
  initialId?: string;
  startup?: Startup;
  initialNotice?: string;
  onEnroll: (request: Enrollment) => void;
  onNative: (sessionId: string) => void;
  initialCommand?: string;
  onOperation: (request: {
    run: () => Promise<unknown>;
    sessionId?: string;
    directory: string;
    preferences: Preferences;
  }) => void;
}) {
  const [id, setId] = useState(initialId);
  const [usage, setUsage] = useState<UnifiedInventory>({
    native: null,
    enrolled: [],
    warnings: [],
  });
  const [directory, setDirectory] = useState(startup?.directory ?? '');
  const [preferences, setPreferences] = useState<Preferences>(startup?.preferences ?? {});
  const { exit } = useApp(),
    { stdout } = useStdout();
  const { setCursorPosition } = useCursor();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [draft, setDraft] = useState(''),
    [notice, setNotice] = useState(initialNotice ?? help),
    [view, setView] = useState('conversation'),
    [scroll, setScroll] = useState<number | null>(null),
    [selected, setSelected] = useState(id),
    [pending, setPending] = useState(false);
  const draftRef = useRef('');
  const pendingRef = useRef(false);
  const pasting = useRef(false);
  const legacyMouse = useRef<number>(0);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsHidden, setSuggestionsHidden] = useState(false);
  const suggestions = suggestionsHidden ? [] : commandSuggestions(draft);
  const pickedCommand = suggestions[suggestionIndex % Math.max(1, suggestions.length)];
  function writeDraft(next: string | ((value: string) => string)) {
    draftRef.current = typeof next === 'function' ? next(draftRef.current) : next;
    setDraft(draftRef.current);
    setSuggestionIndex(0);
    setSuggestionsHidden(false);
  }
  const clientId = useRef(uid());
  const mounted = useRef(true);
  const cursor = useRef(0);
  useEffect(() => {
    if (!selected) return;
    let polling = false;
    let attached = true;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const [s, events] = await Promise.all([
          rpc('sessions.snapshot', { id: selected }),
          rpc('sessions.events', { id: selected, after: cursor.current }),
        ]);
        if (mounted.current && attached) {
          setSnapshot(s);
          if (events.length) cursor.current = events.at(-1).seq;
        }
      } catch (e) {
        if (mounted.current && attached) setNotice((e as Error).message);
      } finally {
        polling = false;
      }
    };
    cursor.current = 0;
    void poll();
    const timer = setInterval(poll, 250);
    return () => {
      attached = false;
      clearInterval(timer);
    };
  }, [selected]);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  async function openProject(directory: string) {
    if (!startup) throw new Error('Choose a project with /project PATH');
    const session = await startup.create(directory, preferences);
    if (!mounted.current) return;
    setId(session.id);
    setSelected(session.id);
    setSnapshot(null);
    setDirectory(directory);
    setView('conversation');
    setScroll(null);
    setNotice(initialNotice ?? `Working directory: ${directory} · ${help}`);
    if (preferences.model)
      await rpc('sessions.configure', { id: session.id, model: preferences.model });
    return session.id;
  }
  useEffect(() => {
    if (initialCommand) void submit(initialCommand);
  }, []);
  function operation(run: () => Promise<unknown>) {
    onOperation({ run, sessionId: id, directory, preferences });
    exit();
  }
  async function submit(text: string) {
    if (!text.trim() || pendingRef.current) return;
    if (text === '/native') text = '/mode native';
    if (text.startsWith('/exec ')) text = text.slice(6);
    pendingRef.current = true;
    setPending(true);
    try {
      if (text.startsWith('/')) {
        const [command, ...args] = text.trim().split(/\s+/),
          arg = args.join(' ');
        if (command === '/exit' || command === '/quit') {
          exit();
          return;
        }
        if (
          [
            '/sessions',
            '/dashboard',
            '/profiles',
            '/p',
            '/agents',
            '/codex',
            '/cdx',
            '/antigravity',
            '/agy',
          ].includes(command) &&
          !arg
        ) {
          operation(async () => {
            await discoverNativeProfiles();
            return managementDashboard(
              ['/profiles', '/p', '/codex', '/cdx', '/antigravity', '/agy'].includes(command) ? 1 : 0,
              directory,
            );
          });
          return;
        }
        if (command === '/dashboard' && args[0] === 'runs') {
          operation(async () => {
            const { dashboard } = await import('./dashboard.js');
            return dashboard(args[1]);
          });
          return;
        }
        if (command === '/login') {
          if (!arg) throw new Error('Use /login PROFILE, or /profiles to choose a profile');
          operation(() => loginProfile(arg));
          return;
        }
        if (command === '/inspect') {
          if (!arg) throw new Error('Use /inspect PROFILE, or Check authentication in /profiles');
          const result = await managementRpc('profiles.inspect', { profile: arg });
          setNotice(
            result.reason ??
              `${result.profile.label}: ${result.profile.auth} · ${result.profile.reportedAccount ?? 'identity not reported'}`,
          );
          setView('details');
          setScroll(0);
          writeDraft('');
          return;
        }
        if (['/doctor', '/d', '/doc'].includes(command) && !arg) {
          operation(() => managementDashboard(3, directory));
          return;
        }
        if (command === '/enroll') {
          const provider = normalizeTool(args[0]);
          if (provider !== 'codex' && provider !== 'antigravity')
            throw new Error(
              'Use /enroll codex|antigravity (or cdx|agy) [LABEL] for an isolated Principal account; /profiles reuses existing native logins.',
            );
          onEnroll({
            provider: provider as Provider,
            label: args[1],
            sessionId: id,
            directory,
            preferences,
          });
          exit();
          return;
        }
        if (
          [
            '/init',
            '/runtime',
            '/profiles',
            '/p',
            '/folders',
            '/launch',
            '/l',
            '/swap',
            '/sw',
            '/switch',
            '/agents',
            '/pools',
            '/models',
            '/plan',
            '/run',
            '/status',
            '/logs',
            '/cancel',
            '/integrate',
            '/prune',
            '/tasks',
            '/conversations',
            '/doctor',
            '/d',
            '/doc',
          ].includes(command) ||
          (command === '/accounts' && arg)
        ) {
          setView('details');
          setScroll(0);
          let result = '';
          await executeTuiCommand(text, {
            directory,
            output: (line) => {
              result += (result ? '\n' : '') + line;
              if (mounted.current) setNotice(result);
            },
            handoff: (run) => operation(run),
          });
          writeDraft('');
          return;
        }
        if (command === '/resume' && arg) {
          const native = await managementRpc('snapshot');
          if (native.entries.some((e: any) => e.id === arg)) {
            operation(() => resumeEntry(arg));
            return;
          }
          await rpc('sessions.resume', { id: arg });
          setId(arg);
          setSelected(arg);
          setSnapshot(null);
          setView('conversation');
          setNotice('Conversation resumed');
          writeDraft('');
          return;
        }
        if (command === '/stop' && arg) {
          await managementRpc('invocations.stop', { id: arg });
          setNotice('Stop requested for the owned invocation');
          writeDraft('');
          return;
        }
        if (command === '/mode') {
          if (!arg || arg === 'principal')
            setNotice(
              'Mode: principal · unified conversation, delegation and reviewed changes. Use /mode native to open the selected provider directly.',
            );
          else if (arg === 'native') {
            const sessionId = id ?? (await openProject(directory));
            if (!sessionId) throw new Error('Connect an account before entering native mode');
            onNative(sessionId);
            exit();
            return;
          } else throw new Error('Use /mode principal or /mode native');
        } else if (command === '/project') {
          if (!arg) throw new Error('Use /project /path/to/your/project');
          const chosen = path.resolve(
            arg === '~'
              ? homedir()
              : arg.startsWith('~/')
                ? path.join(homedir(), arg.slice(2))
                : arg,
          );
          if (!(await stat(chosen)).isDirectory())
            throw new Error('Choose an existing project directory');
          setDirectory(chosen);
          setId(undefined);
          setSelected(undefined);
          setSnapshot(null);
          setView('conversation');
          setNotice(
            `Project selected: ${chosen}. Previous work keeps running; a conversation starts on your next message.`,
          );
        } else if (command === '/resume' && !id && arg) {
          await rpc('sessions.resume', { id: arg });
          setId(arg);
          setSelected(arg);
          setNotice(help);
        } else if (
          !id &&
          ![
            '/help',
            '/accounts',
            '/sessions',
            '/usage',
            '/resources',
            '/pool',
            '/model',
            '/lead',
            '/back',
            '/chat',
          ].includes(command)
        ) {
          throw new Error(
            'Choose a project with /project PATH first, or resume with /resume SESSION_ID',
          );
        } else if (command === '/help') {
          setNotice(
            [
              'PRINCIPAL · commands stay inside this application',
              '',
              ...chatCommands.map(
                (c) => `${c.name}${c.args ? ' ' + c.args : ''} · ${c.description}`,
              ),
              '',
              'Default native configurations are discovered; their presence does not prove login.',
              'Use /profiles for native login, launch and history menus. /sessions opens the folder tree.',
              '/dashboard runs opens orchestration monitoring. /back returns to this prompt.',
            ].join('\n'),
          );
          setView('details');
          setScroll(0);
        } else if (command === '/workers') {
          if (arg) {
            setSelected(arg);
            setView('conversation');
            setScroll(null);
          } else {
            setView('agents');
            setScroll(0);
          }
        } else if (command === '/history') {
          setView('conversation');
          setScroll(null);
        } else if (command === '/usage' || command === '/resources') {
          setUsage(await inventory({ refresh: args.includes('--refresh'), nativeRefresh: true }));
          setView('usage');
          setScroll(0);
          setNotice(
            'All discovered native profiles and enrolled accounts · /usage --refresh updates supported limits · PgUp/PgDn scroll',
          );
        } else if (command === '/accounts') {
          setNotice(inventoryAccounts(await inventory({ inspect: true })).join('\n'));
          setView('details');
          setScroll(0);
        } else if (command === '/back' || command === '/chat') {
          setView('conversation');
          setScroll(null);
          setNotice('Principal · /help for commands');
        } else if (command === '/sessions' && arg === '--saved') {
          const sessions = await rpc('sessions.list');
          setNotice(
            [
              'SAVED PRINCIPAL CONVERSATIONS',
              ...sessions.map((s: any) => `${s.id} · ${s.provider} · ${s.status} · ${s.repo}`),
              '/resume ID attaches without replaying work',
            ].join('\n'),
          );
          setView('details');
          setScroll(0);
        } else if (command === '/pool' || command === '/model') {
          if (!arg) {
            if (!id && command === '/model') {
              setNotice(`Next conversation model: ${preferences.model ?? 'provider default'}`);
              writeDraft('');
              return;
            }
            setNotice(
              JSON.stringify(
                await rpc(
                  command === '/pool' ? 'pools.list' : 'models',
                  command === '/pool' ? {} : { account: snapshot?.session.leadAccountId },
                ),
                null,
                2,
              ),
            );
            setView('details');
            setScroll(0);
            writeDraft('');
            return;
          }
          if (!id) {
            setPreferences((p) => ({ ...p, [command === '/pool' ? 'pool' : 'model']: arg }));
            setNotice('Selection saved for the next project conversation');
            writeDraft('');
            return;
          }
          await rpc('sessions.configure', { id, [command === '/pool' ? 'pool' : 'model']: arg });
          setNotice('Settings updated for subsequent turns');
        } else if (command === '/lead') {
          if (!args[0])
            throw new Error('Use /lead ACCOUNT; append confirm to approve a provider change');
          if (!id) {
            setPreferences((p) => ({ ...p, lead: args[0] }));
            setNotice('Lead selected for the next project conversation');
            writeDraft('');
            return;
          }
          await rpc('sessions.configure', {
            id,
            lead: args[0],
            confirmProvider: args[1] === 'confirm',
          });
          setNotice('Lead updated');
        } else if (command === '/answer') {
          if (args.length < 2)
            throw new Error(
              'Use /answer QUESTION_ID TEXT; native questions accept an answers JSON object',
            );
          const answer = args.slice(1).join(' ');
          let answers;
          try {
            answers = JSON.parse(answer);
          } catch {}
          await rpc('sessions.answer', { id, questionId: args[0], answer, answers });
          setNotice('Answer admitted');
        } else {
          const operations: Record<string, string> = {
            '/context': 'context',
            '/compact': 'compact',
            '/review': 'review',
            '/apply': 'apply',
            '/refresh': 'refresh',
            '/stop': 'interrupt',
            '/resume': 'resume',
          };
          const op = operations[command];
          if (!op) throw new Error(`Unknown command. ${help}`);
          const result = await rpc(`sessions.${op}`, { id: op === 'context' ? selected : id });
          setNotice(
            op === 'review' ? result.patch || 'No agent changes' : JSON.stringify(result, null, 2),
          );
          setView(op === 'review' ? 'review' : 'details');
          setScroll(0);
        }
      } else {
        const sessionId = id ?? (await openProject(directory));
        const receipt = await rpc('sessions.submit', {
          id: sessionId,
          input: text,
          clientMessageId: clientId.current,
        });
        clientId.current = uid();
        setNotice(`Admitted ${receipt.clientMessageId} · ${receipt.delivery}`);
        setView('conversation');
        setScroll(null);
      }
      writeDraft('');
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  function moveScroll(direction: 'up' | 'down' | 'top' | 'bottom', step = 3) {
    setScroll((offset) => moveViewport(displayRows.length, height, offset, direction, step));
  }
  useInput((input, key) => {
    if (!pasting.current) {
      const wheel = mouseScroll(input);
      if (wheel !== undefined) {
        if (wheel) moveScroll(wheel);
        return;
      }
      // Old terminals may fall back to X10 reports despite SGR negotiation.
      if (input === '[M') {
        legacyMouse.current = 3;
        return;
      }
      if (legacyMouse.current) {
        if (legacyMouse.current === 3 && input.length) {
          const button = input.charCodeAt(0) - 32;
          if (button & 64) {
            if ((button & 3) === 0) moveScroll('up');
            if ((button & 3) === 1) moveScroll('down');
          }
        }
        const consumed = Math.min(legacyMouse.current, input.length);
        legacyMouse.current -= consumed;
        input = input.slice(consumed);
        if (!input) return;
      }
    }
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    if (key.pageUp) {
      moveScroll('up', Math.max(1, height - 1));
      return;
    }
    if (key.pageDown) {
      moveScroll('down', Math.max(1, height - 1));
      return;
    }
    if (!pendingRef.current && suggestions.length && !pasting.current) {
      if (key.escape) {
        setSuggestionsHidden(true);
        return;
      }
      if (key.upArrow || key.downArrow) {
        setSuggestionIndex(
          (index) => (index + (key.upArrow ? -1 : 1) + suggestions.length) % suggestions.length,
        );
        return;
      }
      if (
        key.tab ||
        (key.return && !key.shift && !key.meta && draftRef.current !== pickedCommand?.name)
      ) {
        if (pickedCommand) writeDraft(pickedCommand.name + (pickedCommand.args ? ' ' : ''));
        return;
      }
    }
    if (key.home || key.end) {
      moveScroll(key.home ? 'top' : 'bottom');
      return;
    }
    if ((key.upArrow || key.downArrow) && !pasting.current) {
      moveScroll(key.upArrow ? 'up' : 'down', 1);
      return;
    }
    if (key.tab) {
      const next =
        view === 'conversation' ? 'agents' : view === 'agents' ? 'details' : 'conversation';
      setView(next);
      setScroll(next === 'conversation' ? null : 0);
      return;
    }
    if (pendingRef.current) return;
    if (input.includes('[200~') || input.includes('[201~') || pasting.current) {
      pasting.current = !input.includes('[201~');
      writeDraft((x) => x + input.replace(/(?:\x1b)?\[20[01]~/g, '').replace(/\r/g, '\n'));
      return;
    }
    if (key.return) {
      if (key.shift || key.meta) writeDraft((x) => x + '\n');
      else void submit(draftRef.current);
      return;
    }
    if (key.backspace || key.delete) {
      writeDraft((x) => Array.from(x).slice(0, -1).join(''));
      return;
    }
    if (key.ctrl && input === 'u') {
      writeDraft('');
      return;
    }
    if (!key.ctrl && !key.meta)
      writeDraft((x) => x + input.replace(/(?:\x1b)?\[20[01]~/g, '').replace(/\r\n?/g, '\n'));
  });
  const s = snapshot?.session;
  const terminalRows = stdout.rows || 24;
  const compact = terminalRows < 18;
  const draftLines = pending ? 1 : Math.min(2, Math.max(1, draft.split('\n').length));
  const suggestionLimit = Math.max(
    0,
    Math.min(4, terminalRows - (compact ? 11 : 13) - (draftLines - 1)),
  );
  const suggestionStart = Math.max(0, suggestionIndex - suggestionLimit + 1);
  const visibleSuggestions = suggestions.slice(suggestionStart, suggestionStart + suggestionLimit);
  const height = Math.max(
    1,
    terminalRows - (compact ? 10 : 12) - visibleSuggestions.length - (draftLines - 1),
  );
  const usageRows = inventoryUsage(usage, Math.max(1, (stdout.columns ?? 80) - 4));
  let content: string[] = [];
  if (view === 'conversation') {
    content = (snapshot?.messages ?? []).flatMap((m) =>
      m.parts.flatMap((p) => {
        if (p.type === 'text') return `${m.role}: ${cleanText(p.text)}`.split('\n');
        if (p.type === 'question')
          return [`Question ${p.id}${p.answered ? ' (answered)' : ''}: ${cleanText(p.text)}`];
        if (p.type === 'artifact') return [`Artifact ${p.id}: ${cleanText(p.preview)}`];
        if (p.type === 'tool') return [`${p.at} ${cleanText(p.name)} · ${p.state}`];
        if (p.type === 'result') return [`Run ${p.runId}: ${cleanText(p.summary)}`];
        return [`Context: ${p.operation}`];
      }),
    );
    // Structured lead control output is internal; show the validated reply when it settles.
    if (snapshot?.partial && !snapshot.partial.trimStart().startsWith('{'))
      content.push('assistant (streaming): ' + cleanText(snapshot.partial));
    const active = snapshot?.turns.find((turn) => ['running', 'dispatching'].includes(turn.status));
    if (active) {
      const elapsed = Math.max(
        0,
        Math.floor((Date.now() - Date.parse(active.dispatchAt ?? active.createdAt)) / 1000),
      );
      content.push(
        `${s?.provider ?? 'Agent'} is responding · ${elapsed}s · ${s?.currentAction ?? 'waiting for provider output'}`,
      );
    } else if (s && ['queued', 'waiting_quota'].includes(s.status)) {
      content.push('Waiting for an available account · your message is saved in the queue');
    }

    if (!id)
      content.push(
        'Welcome to Principal',
        `Directory: ${directory}`,
        'Existing logins: /accounts · All supported limits: /usage',
        'Folder tree: /sessions · Profile setup: /profiles',
        'Native agent launch: /profiles · Project conversations use enrolled accounts.',
        'Type /help for all commands.',
        'Resume a conversation: /resume SESSION_ID',
      );
  } else if (view === 'usage') {
    content = usageRows.map((row) => row.text);
  } else if (view === 'agents') {
    content = (snapshot?.children ?? []).map(
      (c) =>
        `${c.worker?.taskId ?? c.id} · ${c.id} · ${c.provider} · ${c.model ?? 'default'} · ${c.leadAccountId} · ${c.status} · ${Math.max(0, Math.floor((Date.parse(c.finishedAt ?? new Date().toISOString()) - Date.parse(c.startedAt ?? c.createdAt)) / 1000))}s · ${c.currentAction ?? 'awaiting activity'} · last ${c.lastActivityAt ?? c.createdAt}${c.error ? ` · ${c.error}` : ''}`,
    );
    content.push(
      'Use /agents SESSION_ID to inspect a child; /agents ' + id + ' returns to the lead',
    );
  } else content = cleanText(notice).split('\n');
  const width = Math.max(1, (stdout.columns ?? 80) - 4);
  const displayRows = content.flatMap((line) => {
    const chars = Array.from(line);
    const rows = [];
    for (let offset = 0; offset < chars.length; offset += width)
      rows.push({
        text: chars.slice(offset, offset + width).join(''),
        color: view === 'usage' ? usageRows.find((row) => row.text === line)?.color : undefined,
      });
    return rows.length ? rows : [{ text: '', color: undefined }];
  });
  const start = viewportStart(displayRows.length, height, scroll);
  const end = Math.min(displayRows.length, start + height);
  const preview = inputPreview(draft, stdout.columns || 80);
  const renderedRows = (compact ? 9 : 11) + height + visibleSuggestions.length + draftLines - 1;
  // Reserve a terminal row for Ink's trailing newline, so cursor coordinates
  // remain relative to the output origin during polling and terminal resizing.
  setCursorPosition(pending ? undefined : { x: preview.cursorColumn, y: renderedRows - 3 });
  const queued = snapshot?.turns.filter((t) => t.status === 'queued').length ?? 0;
  return (
    <Box flexDirection="column">
      <Text bold color="cyan" wrap="truncate-end">
        Principal · {selected ?? 'welcome'} · {view}
      </Text>
      <Text wrap="truncate-end">
        {s
          ? `Pool: ${s.pool} · Account: ${snapshot?.leadAccountLabel ?? s.leadAccountId} · ${s.provider} · ${s.model ?? 'provider default'} · ${s.status}`
          : id
            ? 'Connecting…'
            : 'Ready · /accounts · /usage · /sessions · /help'}
      </Text>
      {!compact && <Text wrap="truncate-end">Directory: {s?.repo ?? directory}</Text>}
      {!compact && (
        <Text wrap="truncate-end">
          {queued} queued · workspace {s?.workspaceVersion ?? '?'} · Tab views · PgUp/PgDn scroll ·
          Shift/Alt+Enter newline
        </Text>
      )}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="blue"
        paddingX={1}
        height={height + 2}
      >
        {displayRows.slice(start, end).map(({ text: line, color }, i) => (
          <Text
            key={i}
            wrap="truncate-end"
            color={
              color ??
              (line.startsWith('user:')
                ? 'green'
                : line.startsWith('assistant')
                  ? 'cyan'
                  : undefined)
            }
          >
            {line || ' '}
          </Text>
        ))}
      </Box>
      <Text color="yellow" wrap="truncate-end">
        {cleanText(s?.error ?? notice.split('\n')[0])}
      </Text>
      {visibleSuggestions.map((command, index) => {
        const active = suggestionStart + index === suggestionIndex;
        return (
          <Text
            key={command.name}
            color={active ? 'cyan' : undefined}
            bold={active}
            wrap="truncate-end"
          >
            {active ? '❯ ' : '  '}
            {command.name}
            {command.args ? ' ' + command.args : ''} · {command.description}
          </Text>
        );
      })}
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        {pending ? (
          <Text color="green">Submitting…</Text>
        ) : (
          preview.lines.map((line, index) => (
            <Text key={index} color="green" wrap="truncate-end">
              {index === 0 ? '❯ ' : '  '}
              {line || (!draft ? <Text dimColor>Ask Principal…</Text> : '')}
            </Text>
          ))
        )}
      </Box>
      <Text dimColor wrap="truncate-end">
        {suggestions.length
          ? '↑/↓ select · Tab complete · Enter complete/run · Esc dismiss'
          : `Rows ${displayRows.length ? start + 1 : 0}-${end}/${displayRows.length} · PgUp/PgDn or wheel · / commands`}
      </Text>
    </Box>
  );
}
export async function chat(id?: string, startup?: Startup) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Principal requires an interactive terminal');
  let currentId = id;
  let currentStartup = startup;
  let initialCommand: string | undefined;
  let initialNotice: string | undefined = startup?.notice;
  for (;;) {
    let request: Enrollment | undefined;
    let nativeId: string | undefined;
    let operationRequest:
      | {
          run: () => Promise<unknown>;
          sessionId?: string;
          directory: string;
          preferences: Preferences;
        }
      | undefined;
    process.stdout.write(terminalInputOn);
    const terminate = () => {
      process.stdout.write(terminalInputOff);
      process.exit(143);
    };
    const hangup = () => {
      process.stdout.write(terminalInputOff);
      process.exit(129);
    };
    process.once('SIGTERM', terminate);
    process.once('SIGHUP', hangup);
    try {
      const instance = render(
        <Chat
          initialId={currentId}
          startup={currentStartup}
          initialCommand={initialCommand}
          onOperation={(value) => {
            operationRequest = value;
          }}
          initialNotice={initialNotice}
          onNative={(value) => {
            nativeId = value;
          }}
          onEnroll={(value) => {
            request = value;
          }}
        />,
      );
      await instance.waitUntilExit();
      instance.unmount();
      initialCommand = undefined;
    } finally {
      process.removeListener('SIGTERM', terminate);
      process.removeListener('SIGHUP', hangup);
      process.stdout.write(terminalInputOff);
    }
    if (operationRequest) {
      currentId = operationRequest.sessionId;
      if (currentStartup)
        currentStartup = {
          ...currentStartup,
          directory: operationRequest.directory,
          preferences: operationRequest.preferences,
        };
      try {
        const result = await operationRequest.run();
        if (result && typeof result === 'object' && 'command' in result)
          initialCommand = String(result.command);
        initialNotice =
          typeof result === 'number'
            ? `Native tool exited (${result}); returned to Principal.`
            : 'Returned to Principal · /help for commands';
      } catch (error) {
        initialNotice = (error as Error).message;
      }
      continue;
    }
    if (nativeId) {
      currentId = nativeId;
      try {
        await openNative({ sessionId: nativeId });
        initialNotice =
          'Returned to Principal mode · native history stays with the provider. If files changed, use /refresh before continuing project work.';
      } catch (error) {
        initialNotice = (error as Error).message;
      }
      continue;
    }
    if (!request) return;
    currentId = request.sessionId;
    if (currentStartup && request.directory)
      currentStartup = {
        ...currentStartup,
        directory: request.directory,
        preferences: request.preferences,
      };
    try {
      const session = currentId
        ? (await rpc('sessions.snapshot', { id: currentId })).session
        : undefined;
      const config =
        session?.config ??
        (await currentStartup?.settings?.(currentStartup.directory)) ??
        ConfigSchema.parse({});
      const pool = session?.pool ?? currentStartup?.preferences?.pool ?? config.pool;
      const account = await enrollAccount(request.provider, { label: request.label, config });
      await rpc('pools.addAccount', { pool, account: account.id });
      initialNotice = `Connected ${account.label}${account.identity ? ' (' + account.identity + ')' : ''} · added to pool ${pool}`;
      if (currentId) {
        try {
          await rpc('sessions.configure', { id: currentId, pool });
        } catch {
          initialNotice +=
            ' · active work keeps its current pool; use /pool ' + pool + ' after it settles';
        }
      }
    } catch (error) {
      initialNotice = (error as Error).message;
    }
  }
}
