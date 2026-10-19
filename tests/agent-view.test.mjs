import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'ink';
import { AgentActivity, agentCards, preferredRun, duration } from '../dist/agent-view.js';
import { AgentsView } from '../dist/dashboard.js';
const at = '2026-10-07T00:00:00.000Z';
const event = (seq, attemptId, type, data) => ({
  seq,
  attemptId,
  taskId: attemptId,
  runId: 'r',
  type,
  at,
  data,
});
const accounts = [
  { id: 'a', label: 'codex-free-1', provider: 'codex', model: 'gpt-6-luna' },
  { id: 'b', label: 'codex-free-2', provider: 'codex', model: 'gpt-6-luna' },
];
const state = {
  run: { id: 'r', status: 'running' },
  tasks: [
    {
      id: 'review',
      status: 'running',
      attempts: 1,
      spec: { instruction: 'Review design', dependsOn: [], account: 'codex-free-1' },
    },
    {
      id: 'research',
      status: 'running',
      attempts: 1,
      spec: { instruction: 'Research tools', dependsOn: [], account: 'codex-free-2' },
    },
  ],
  attempts: [
    {
      id: 'x',
      taskId: 'review',
      accountId: 'a',
      startedAt: at,
      status: 'running',
      model: 'gpt-6-luna',
    },
    {
      id: 'y',
      taskId: 'research',
      accountId: 'b',
      startedAt: at,
      status: 'running',
      model: 'gpt-6-luna',
    },
  ],
};
test('interleaved messages stay with their actual agent', () => {
  const activity = new AgentActivity();
  activity.ingest([
    event(1, 'x', 'text_delta', { text: 'Read' }),
    event(2, 'y', 'text_delta', { text: 'Searching' }),
    event(3, 'x', 'text_delta', { text: ' docs' }),
  ]);
  const cards = agentCards(state, accounts, activity, Date.parse(at) + 65000);
  assert.equal(cards[0].message, 'Read docs');
  assert.equal(cards[1].message, 'Searching');
  assert.equal(cards[0].elapsed, '1m 5s');
  assert.equal(cards[1].account, 'codex-free-2');
});
test('replayed events are idempotent and telemetry does not fake progress', () => {
  const activity = new AgentActivity();
  const e = event(1, 'x', 'text_delta', { text: 'Hello' });
  activity.ingest([e]);
  activity.ingest([e, event(2, 'x', 'quota', {})]);
  assert.equal(activity.attempts.get('x').message, 'Hello');
  assert.equal(activity.attempts.get('x').updatedAt, at);
  assert.equal(activity.cursor, 2);
});
test('tool actions and tokens are derived from actual events', () => {
  const activity = new AgentActivity();
  activity.ingest([
    event(1, 'x', 'tool', { type: 'commandExecution' }),
    event(2, 'y', 'tool', { type: 'webSearch' }),
    event(3, 'x', 'usage', { tokenUsage: { total: { totalTokens: 42 } } }),
  ]);
  assert.equal(activity.attempts.get('x').action, 'Running a command');
  assert.equal(activity.attempts.get('y').action, 'Searching the web');
  assert.equal(activity.attempts.get('x').tokens, 42);
});
test('completed elapsed time stops and structured results are parsed', () => {
  const activity = new AgentActivity();
  activity.ingest([event(1, 'x', 'attempt_finished', { status: 'completed' })]);
  const done = structuredClone(state);
  done.tasks[0].status = 'completed';
  done.tasks[0].result = JSON.stringify({
    summary: 'Found two bugs',
    remainingIssues: ['Fix them'],
  });
  done.attempts[0].status = 'completed';
  const card = agentCards(done, accounts, activity, Date.parse(at) + 999000)[0];
  assert.equal(card.elapsed, '0s');
  assert.equal(card.result, 'Found two bugs');
  assert.deepEqual(card.issues, ['Fix them']);
});
test('new attempt does not inherit old message or tokens', () => {
  const activity = new AgentActivity();
  activity.ingest([event(1, 'old', 'text_delta', { text: 'Old attempt' })]);
  assert.equal(agentCards(state, accounts, activity)[0].message, '');
});
test('prefers newest active run without mutating source order', () => {
  const runs = [
    { id: 'finished', status: 'applied', createdAt: '2026-10-07' },
    { id: 'active', status: 'running', createdAt: '2026-10-06' },
  ];
  assert.equal(preferredRun(runs).id, 'active');
  assert.equal(runs[0].id, 'finished');
  assert.equal(preferredRun([]), undefined);
});
test('renders both agents side by side in a wide terminal', () => {
  const activity = new AgentActivity();
  activity.ingest([
    event(1, 'x', 'tool', { type: 'commandExecution' }),
    event(2, 'y', 'tool', { type: 'webSearch' }),
  ]);
  const output = renderToString(
    React.createElement(AgentsView, {
      cards: agentCards(state, accounts, activity, Date.parse(at) + 5000),
      selected: 0,
      width: 120,
      rows: 30,
      details: false,
    }),
    { columns: 120 },
  );
  assert.match(output, /codex-free-1/);
  assert.match(output, /codex-free-2/);
  assert.match(output, /Running a command/);
  assert.match(output, /Searching the web/);
  assert(output.split('\n').some((line) => line.includes('review') && line.includes('research')));
  assert(output.split('\n').length < 20);
});
test('small terminal paginates agents without hiding selected task', () => {
  const cards = agentCards(state, accounts, new AgentActivity());
  const output = renderToString(
    React.createElement(AgentsView, { cards, selected: 1, width: 80, rows: 24, details: false }),
    { columns: 80 },
  );
  assert.match(output, /codex-free-2/);
  assert.doesNotMatch(output, /codex-free-1/);
  assert.match(output, /Tasks 2–2 of 2/);
});
test('elapsed duration handles negative clock skew', () => assert.equal(duration(-1000), '0s'));

test('retries show current activity rather than the previous failed result', () => {
  const retry = structuredClone(state);
  retry.tasks[0].result = JSON.stringify({
    summary: 'Old failed attempt',
    remainingIssues: ['Old issue'],
  });
  const activity = new AgentActivity();
  activity.ingest([event(1, 'x', 'text_delta', { text: 'Reading current files' })]);
  const card = agentCards(retry, accounts, activity)[0];
  assert.equal(card.result, '');
  assert.deepEqual(card.issues, []);
  assert.equal(card.message, 'Reading current files');
});
test('details scroll without exceeding a small terminal height', () => {
  const cards = agentCards(state, accounts, new AgentActivity());
  cards[0].result = Array.from({ length: 100 }, (_, i) => `Finding ${i}`).join(' ');
  const output = renderToString(
    React.createElement(AgentsView, {
      cards,
      selected: 0,
      width: 80,
      rows: 24,
      details: true,
      offset: 3,
    }),
    { columns: 80 },
  );
  assert.match(output, /PgUp\/PgDn/);
  assert(output.split('\n').length <= 18);
});
