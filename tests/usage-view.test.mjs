import test from 'node:test';
import assert from 'node:assert/strict';
import { usageLines, resetCountdown } from '../dist/usage-view.js';
const now = Date.parse('2026-10-08T00:00:00Z');
const account = {
  id: 'a',
  label: 'antigravity-1',
  provider: 'antigravity',
  identity: 'test@example.com',
};
const bucket = (id, percent) => ({
  id,
  name: id,
  models: [],
  remainingPercent: percent,
  resetAt: '2026-10-13T16:53:00Z',
  windowMinutes: null,
});

test('Antigravity separates Gemini and Claude/GPT weekly meters without averaging buckets', () => {
  const rows = usageLines(
    [
      {
        account,
        quota: {
          state: 'reported',
          observedAt: new Date(now).toISOString(),
          buckets: [
            bucket('Gemini Models/gemini-weekly', 0),
            bucket('Claude and GPT models/3p-weekly', 99.04),
            bucket('Gemini Models/gemini-5h', 81),
            bucket('Claude and GPT models/3p-5h', 73),
          ],
        },
      },
    ],
    60,
    now,
    'a',
  );
  const text = rows.map((r) => r.text).join('\n');
  assert.match(text, /antigravity-1.*active/);
  assert.match(text, /Gemini · weekly/);
  assert.match(text, /Claude · weekly/);
  assert.doesNotMatch(text, /5-hour|81\.00%|73\.00%/);
  assert.match(text, /0\.00%/);
  assert.match(text, /99\.04%/);
  assert.match(text, /Refreshes in 136h 53m/);
  assert.ok(rows.find((r) => r.text.includes('0.00%')).color === 'red');
  assert.ok(rows.filter((r) => r.text.startsWith('[')).every((r) => r.text.length <= 60));
});
test('unreported quotas stay unknown and stale values are visibly historical', () => {
  const unknown = usageLines([{ account, quota: null }], 55, now)
    .map((r) => r.text)
    .join('\n');
  assert.equal((unknown.match(/unknown/g) ?? []).length, 4);
  assert.doesNotMatch(unknown, /0\.00%/);
  const stale = usageLines(
    [
      {
        account,
        quota: {
          state: 'reported',
          observedAt: '2026-10-07T00:00:00Z',
          buckets: [bucket('gemini-weekly', 40)],
        },
      },
    ],
    55,
    now,
  )
    .map((r) => r.text)
    .join('\n');
  assert.match(stale, /STALE · last reported/);
});
test('Codex shows reported windows and accounts outside the active pool remain visible', () => {
  const text = usageLines(
    [
      {
        account: { ...account, id: 'c', label: 'codex-free-1', provider: 'codex' },
        quota: {
          state: 'reported',
          observedAt: new Date(now).toISOString(),
          buckets: [{ ...bucket('codex/primary', 94), windowMinutes: 43200 }],
        },
      },
      { account, quota: null },
    ],
    70,
    now,
  )
    .map((r) => r.text)
    .join('\n');
  assert.match(text, /30-day limit remaining/);
  assert.match(text, /94\.00%/);
  assert.match(text, /codex-free-1/);
  assert.match(text, /antigravity-1/);
  assert.equal(resetCountdown(null, now), 'Reset time unknown');
  assert.equal(resetCountdown('2026-10-07T00:00:00Z', now), 'Reset time reached · refresh usage');
});
