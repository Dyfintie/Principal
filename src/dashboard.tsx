import { useState, useEffect, useRef } from 'react';
import { render, Box, Text, useInput, useApp, useStdout } from 'ink';
import { rpc } from './client.js';
import { cleanText } from './util.js';
import { readableStatus, formatRemainingPercent } from './presentation.js';
import { AgentActivity, agentCards, preferredRun, type AgentCard } from './agent-view.js';
import type { Run, Account } from './schema.js';

const names = ['Agents', 'Accounts', 'Runs', 'Tasks', 'Review', 'Diagnostics'];
const color = (status: string) =>
  status === 'completed' || status === 'applied' || status === 'ready_for_review'
    ? 'green'
    : status === 'needs_review' || status === 'failed'
      ? 'red'
      : status === 'running'
        ? 'cyan'
        : 'yellow';
function lines(text: string, width: number, count: number) {
  const value = cleanText(text).replace(/\s+/g, ' ').trim();
  const result = [];
  for (let i = 0; i < value.length && result.length < count; i += width)
    result.push(value.slice(i, i + width));
  if (value.length > width * count && result.length)
    result[result.length - 1] = result.at(-1)!.slice(0, Math.max(0, width - 1)) + '…';
  return result.length ? result : ['Waiting for a message'];
}
export function AgentPanel({
  card,
  selected,
  width,
  compact = false,
}: {
  card: AgentCard;
  selected: boolean;
  width: number;
  compact?: boolean;
}) {
  const text =
    card.result ||
    (card.message.trimStart().startsWith('{') ? 'Preparing the structured result…' : card.message);
  return (
    <Box
      width={width}
      flexDirection="column"
      borderStyle="round"
      borderColor={selected ? 'cyan' : 'gray'}
      paddingX={1}
    >
      <Text bold wrap="truncate">
        {selected ? '› ' : ''}
        {card.task}
      </Text>
      <Text wrap="truncate">
        {card.account} · {card.provider} · {card.model}
      </Text>
      <Text color={color(card.status)} wrap="truncate">
        {card.status.toUpperCase()} · {card.elapsed} · attempt {card.attempt}
      </Text>
      <Text bold wrap="truncate">
        {card.action}
      </Text>
      <Text dimColor wrap="truncate">
        Last activity: {card.lastActivity}
        {card.tokens !== null ? ` · ${card.tokens.toLocaleString()} tokens` : ''}
      </Text>
      {!compact && (
        <>
          <Text dimColor>{card.result ? 'Result' : 'Latest message'}</Text>
          {lines(text, Math.max(10, width - 4), 3).map((line, i) => (
            <Text key={i} wrap="truncate">
              {line}
            </Text>
          ))}
        </>
      )}
    </Box>
  );
}
export function AgentsView({
  cards,
  selected,
  width,
  rows,
  details,
  offset = 0,
}: {
  cards: AgentCard[];
  selected: number;
  width: number;
  rows: number;
  details: boolean;
  offset?: number;
}) {
  if (!cards.length)
    return <Text dimColor>No worker tasks yet. Planning may still be in progress.</Text>;
  const index = Math.min(selected, cards.length - 1);
  const perPage = details || (width < 100 && rows < 32) ? 1 : 2;
  const start = Math.floor(index / perPage) * perPage;
  const shown = cards.slice(start, start + perPage);
  const horizontal = width >= 100 && perPage === 2;
  const panelWidth = horizontal ? Math.floor(width / 2) : width;
  const card = cards[index];
  const detailLines = lines(
    [card.result || card.message, ...card.issues].join('\n'),
    Math.max(10, width - 2),
    100000,
  );
  const detailCount = Math.max(1, rows - 18);
  const detailOffset = Math.max(0, Math.min(offset, Math.max(0, detailLines.length - detailCount)));
  return (
    <Box flexDirection="column">
      <Text dimColor>
        Tasks {start + 1}–{Math.min(start + perPage, cards.length)} of {cards.length} · ↑/↓ select ·
        Enter {details ? 'close details' : 'details'}
      </Text>
      <Box flexDirection={horizontal ? 'row' : 'column'}>
        {shown.map((c, i) => (
          <AgentPanel
            key={c.task}
            card={c}
            selected={start + i === index}
            width={panelWidth}
            compact={details}
          />
        ))}
      </Box>
      {details && (
        <Box flexDirection="column">
          <Text bold>Task instructions</Text>
          {lines(card.instruction, Math.max(10, width - 2), 1).map((line, i) => (
            <Text key={i} wrap="truncate">
              {line}
            </Text>
          ))}
          <Text bold>
            {card.result ? 'Result / remaining issues' : 'Latest message'} · PgUp/PgDn scroll (
            {detailOffset + 1}/{detailLines.length})
          </Text>
          {detailLines.slice(detailOffset, detailOffset + detailCount).map((line, i) => (
            <Text key={i} wrap="truncate">
              {line}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
function Dashboard({
  initialRunId,
  onCommand,
}: {
  initialRunId?: string;
  onCommand: (text: string) => void;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ width: stdout.columns ?? 100, rows: stdout.rows ?? 30 });
  const [tab, setTab] = useState(0),
    [runs, setRuns] = useState<Run[]>([]),
    [accounts, setAccounts] = useState<Account[]>([]),
    [state, setState] = useState<any>(null),
    [data, setData] = useState<any[]>([]),
    [error, setError] = useState(''),
    [selected, setSelected] = useState(0),
    [details, setDetails] = useState(false),
    [detailOffset, setDetailOffset] = useState(0),
    [runId, setRunId] = useState(initialRunId),
    [now, setNow] = useState(Date.now()),
    [updatedAt, setUpdatedAt] = useState(0),
    [loadingHistory, setLoadingHistory] = useState(false);
  const pinned = useRef(!!initialRunId);
  const history = useRef({ id: '', activity: new AgentActivity() });
  const refreshRef = useRef<(force?: boolean) => Promise<void>>(async () => {});
  useEffect(() => {
    const resize = () => setSize({ width: stdout.columns ?? 100, rows: stdout.rows ?? 30 });
    stdout.on('resize', resize);
    return () => {
      stdout.off('resize', resize);
    };
  }, [stdout]);
  useEffect(() => {
    let disposed = false,
      busy = false;
    async function refresh(force = false) {
      if (busy) return;
      busy = true;
      try {
        const values = await Promise.allSettled([rpc('runs.list'), rpc('accounts.list')]);
        if (values[0].status === 'rejected') throw values[0].reason;
        if (values[1].status === 'rejected') throw values[1].reason;
        const allRuns = values[0].value as Run[],
          allAccounts = values[1].value as Account[];
        const id = pinned.current ? runId : preferredRun(allRuns)?.id;
        let runState = null,
          results: any[] = [],
          catchingUp = false;
        if (id && [0, 3, 4].includes(tab)) {
          runState = await rpc('runs.status', { id });
          runState.accountLabels = Object.fromEntries(allAccounts.map((a) => [a.id, a.label]));
          if (history.current.id !== id) history.current = { id, activity: new AgentActivity() };
          const cache = history.current.activity;
          for (let batch = 0; batch < 8; batch++) {
            const events = await rpc('runs.events', { id, after: cache.cursor });
            cache.ingest(events);
            if (events.length < 1000) break;
            catchingUp = batch === 7;
          }
          if (tab === 4) results = [await rpc('runs.review', { id })];
        }
        if (tab === 1) results = await rpc('usage', { refresh: force });
        if (tab === 5) results = await rpc('pools.list');
        if (disposed) return;
        setRuns(allRuns);
        setAccounts(allAccounts);
        setRunId(id);
        setState(runState);
        setData(results);
        setLoadingHistory(catchingUp);
        setUpdatedAt(Date.now());
        setNow(Date.now());
        setError('');
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      } finally {
        busy = false;
      }
    }
    refreshRef.current = refresh;
    void refresh();
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [tab, runId]);
  const displayState = state?.run.id === runId ? state : null;
  const cards = displayState
    ? agentCards(displayState, accounts, history.current.activity, now)
    : [];
  const runPageSize = Math.max(1, size.rows - 6);
  const runPageStart = Math.floor(selected / runPageSize) * runPageSize;
  const [commandDraft, setCommandDraft] = useState<string | null>(null);
  const commandInput = useRef<string | null>(null);
  function commandTo(value: string | null) {
    commandInput.current = value;
    setCommandDraft(value);
  }
  useInput((input, key) => {
    if (commandInput.current !== null) {
      if (key.escape) commandTo(null);
      else if (key.return) {
        const text = commandInput.current.trim();
        commandTo(null);
        if (text !== '/back') onCommand(text);
        exit();
      } else if (key.backspace || key.delete)
        commandTo([...commandInput.current].slice(0, -1).join(''));
      else if (!key.ctrl && !key.meta) commandTo(commandInput.current + cleanText(input));
      return;
    }
    if (input.startsWith('/')) {
      commandTo(input);
      return;
    }
    if (input === 'q') exit();
    if (key.tab || key.rightArrow || key.leftArrow) {
      setTab((t) => (t + (key.leftArrow ? names.length - 1 : 1)) % names.length);
      setSelected(0);
      setDetails(false);
    }
    const count = tab === 0 ? cards.length : tab === 2 ? runs.length : data.length;
    if (key.pageDown && details) setDetailOffset((s) => s + 3);
    if (key.pageUp && details) setDetailOffset((s) => Math.max(0, s - 3));
    if (key.downArrow) {
      setSelected((s) => Math.min(s + 1, Math.max(0, count - 1)));
      setDetailOffset(0);
    }
    if (key.upArrow) {
      setSelected((s) => Math.max(s - 1, 0));
      setDetailOffset(0);
    }
    if (input === '[' || input === ']') {
      const ordered = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const i = ordered.findIndex((r) => r.id === runId);
      const next = ordered[Math.max(0, Math.min(ordered.length - 1, i + (input === '[' ? -1 : 1)))];
      if (next) {
        pinned.current = true;
        setRunId(next.id);
        setSelected(0);
        setDetails(false);
      }
    }
    if (key.return && tab === 0) {
      setDetails((d) => !d);
      setDetailOffset(0);
    }
    if (key.return && tab === 2 && runs[selected]) {
      pinned.current = true;
      setRunId(runs[selected].id);
      setTab(0);
      setSelected(0);
    }
    if (input === 'r') void refreshRef.current(true);
    if (input === 'c' && tab === 2 && runs[selected])
      void rpc('runs.cancel', { id: runs[selected].id })
        .then(() => refreshRef.current())
        .catch((e) => setError(e.message));
  });
  return (
    <Box flexDirection="column" width={size.width}>
      <Text bold color="cyan" wrap="truncate">
        principal · {names.map((name, i) => (i === tab ? `[${name}]` : name)).join('  ')}
      </Text>
      <Text dimColor>/ commands · Tab/←/→ views · [/] switch run · r refresh · q return</Text>
      {commandDraft !== null && <Text color="green">❯ {commandDraft}▏</Text>}
      <Text dimColor>
        {updatedAt
          ? `Updated ${new Date(updatedAt).toLocaleTimeString()} · refresh every 2s`
          : 'Connecting to coordinator…'}
        {error ? ' · DISPLAY MAY BE STALE' : ''}
        {loadingHistory ? ' · loading earlier events…' : ''}
      </Text>
      {error && <Text color="red">{cleanText(error)}</Text>}
      {[0, 3, 4].includes(tab) && (
        <>
          <Text bold wrap="truncate">
            Run {runId ?? 'none'} · {displayState?.run.status ?? 'loading'}
          </Text>
          <Text wrap="truncate">
            {displayState?.run.graph.goal ??
              displayState?.run.repo ??
              'Start a run to see its agents here.'}
          </Text>
          {displayState?.run.error && (
            <Text color="red" wrap="truncate">
              {cleanText(displayState.run.error)}
            </Text>
          )}
        </>
      )}
      {tab === 0 && (
        <>
          <Text>
            {cards.filter((c) => c.status === 'running').length} running ·{' '}
            {cards.filter((c) => c.status === 'completed').length} completed ·{' '}
            {cards.filter((c) => c.status === 'pending').length} waiting ·{' '}
            {cards.filter((c) => c.status === 'needs_review').length} need review
          </Text>
          <AgentsView
            cards={cards}
            selected={selected}
            width={size.width}
            rows={size.rows}
            details={details}
            offset={detailOffset}
          />
        </>
      )}
      {tab === 2 && (
        <>
          <Text dimColor>↑/↓ select run · Enter view agents · c cancel selected run</Text>
          {runs.slice(runPageStart, runPageStart + runPageSize).map((r, i) => (
            <Text
              key={r.id}
              color={runPageStart + i === selected ? 'cyan' : undefined}
              wrap="truncate"
            >
              {runPageStart + i === selected ? '› ' : ''}
              {r.id} · {r.status} · {r.graph.goal ?? r.repo}
            </Text>
          ))}
        </>
      )}
      {tab === 3 && state && <Text>{readableStatus(state).slice(0, 4000)}</Text>}
      {[1, 4, 5].includes(tab) &&
        data.slice(0, 12).map((item, i) => (
          <Box key={i} flexDirection="column">
            <Text wrap="truncate">
              {tab === 1
                ? `${item.account.label} · ${item.account.provider} · ${item.account.status}${item.busy ? ' · busy' : ''}`
                : cleanText(JSON.stringify(item, null, 2)).slice(0, 3000)}
            </Text>
            {tab === 1 && (
              <Text dimColor wrap="truncate">
                {item.quota
                  ? `${item.quota.state} · ${item.quota.buckets.map((b: any) => `${b.name}: ${formatRemainingPercent(b.remainingPercent)}`).join(' · ')}`
                  : 'Usage unknown'}
              </Text>
            )}
          </Box>
        ))}
    </Box>
  );
}
export async function dashboard(initialRunId?: string) {
  let command: string | undefined;
  const app = render(
    <Dashboard
      initialRunId={initialRunId}
      onCommand={(text) => {
        command = text;
      }}
    />,
  );
  await app.waitUntilExit();
  app.unmount();
  return command ? { command } : undefined;
}
