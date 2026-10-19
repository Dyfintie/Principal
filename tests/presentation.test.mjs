import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableLogs, readableStatus } from '../dist/presentation.js';
const base = { at: '2026-10-06T21:24:20.000Z' };
test('combines fragments and keeps parallel attempts separate', () => {
  const lines = [];
  const logs = new ReadableLogs((line) => lines.push(line));
  for (const [taskId, text] of [
    ['a', 'Hel'],
    ['b', 'Other'],
    ['a', 'lo world.'],
  ])
    logs.event({ ...base, taskId, attemptId: taskId, type: 'text_delta', data: { text } });
  logs.flush();
  assert.deepEqual(lines, ['21:24:20 [a] Hello world.', '21:24:20 [b] Other']);
});
test('hides noisy telemetry but shows assignment and errors', () => {
  const lines = [];
  const logs = new ReadableLogs((line) => lines.push(line));
  logs.event({ ...base, type: 'quota', data: { secret: 'noise' } });
  logs.event({ ...base, type: 'usage', data: {} });
  logs.event({ ...base, type: 'dispatch_intent', taskId: 'a', data: { account: 'free-1' } });
  logs.event({
    ...base,
    type: 'attempt_finished',
    taskId: 'a',
    data: { status: 'failed', error: 'missing bwrap' },
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /free-1/);
  assert.match(lines[1], /missing bwrap/);
});
test('status parses structured results instead of printing escaped JSON', () => {
  const value = {
    run: {
      id: 'r',
      status: 'needs_review',
      repo: '/repo',
      graph: { tasks: [{ id: 'a', account: 'free-1' }] },
    },
    tasks: [
      {
        id: 'a',
        status: 'needs_review',
        result: JSON.stringify({
          status: 'blocked',
          summary: 'Missing bwrap',
          remainingIssues: ['Retry after rebuilding'],
        }),
      },
    ],
    attempts: [{ taskId: 'a', status: 'failed', startedAt: 'now', model: 'm', accountId: 'id' }],
  };
  const text = readableStatus(value);
  assert.match(text, /free-1/);
  assert.match(text, /Missing bwrap/);
  assert.doesNotMatch(text, /\\"/);
});
test('malformed result still remains visible', () => {
  assert.match(
    readableStatus({
      run: { id: 'r', status: 'failed', repo: 'p', graph: { tasks: [] } },
      tasks: [{ id: 'a', status: 'failed', result: 'provider unavailable' }],
      attempts: [],
    }),
    /provider unavailable/,
  );
});

test('buffers incomplete structured results and renders their summaries', () => {
  const lines = [];
  const logs = new ReadableLogs((line) => lines.push(line));
  logs.event({
    ...base,
    taskId: 'a',
    type: 'text_delta',
    data: { text: '{"status":"completed",' },
  });
  logs.flush();
  assert.equal(lines.length, 0);
  logs.event({
    ...base,
    taskId: 'a',
    type: 'text_delta',
    data: { text: '"summary":"Read files successfully","remainingIssues":[]}' },
  });
  logs.flush();
  assert.deepEqual(lines, ['21:24:20 [a] Result completed: Read files successfully']);
});

test('shows the actual account label after fallback', () => {
  const text = readableStatus({
    run: {
      id: 'r',
      status: 'running',
      repo: 'p',
      graph: { tasks: [{ id: 'a', account: 'requested' }] },
    },
    accountLabels: { actual: 'fallback-account' },
    tasks: [{ id: 'a', status: 'running' }],
    attempts: [
      { taskId: 'a', accountId: 'actual', status: 'running', startedAt: 'now', model: 'm' },
    ],
  });
  assert.match(text, /fallback-account/);
  assert.doesNotMatch(text, /requested/);
});
