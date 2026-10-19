import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateQuotaAlerts } from '../dist/management/alerts.js';
import { smartQuotaRecommendations } from '../dist/unified-inventory.js';

test('smart quota recommendations identify highest headroom per model family', () => {
  const profiles = [
    { id: 'p1', label: 'anti_main', tool: 'antigravity', reportedAccount: 'main@test' },
    { id: 'p2', label: 'anti_2', tool: 'antigravity', reportedAccount: 'sec@test' },
  ];
  const now = Date.now();
  const resources = [
    {
      profileId: 'p1',
      bucket: 'gemini-weekly',
      value: 90,
      unit: 'percent',
      metric: 'quota-remaining',
      observedAt: new Date(now).toISOString(),
    },
    {
      profileId: 'p1',
      bucket: '3p-weekly',
      value: 20,
      unit: 'percent',
      metric: 'quota-remaining',
      observedAt: new Date(now).toISOString(),
    },
    {
      profileId: 'p2',
      bucket: 'gemini-weekly',
      value: 40,
      unit: 'percent',
      metric: 'quota-remaining',
      observedAt: new Date(now).toISOString(),
    },
    {
      profileId: 'p2',
      bucket: '3p-weekly',
      value: 95,
      unit: 'percent',
      metric: 'quota-remaining',
      observedAt: new Date(now).toISOString(),
    },
  ];

  const rec = smartQuotaRecommendations('antigravity', profiles, resources);
  assert.ok(rec);
  assert.match(rec, /Optimal Gemini → anti_main \(90\.0%\)/);
  assert.match(rec, /Optimal Claude → anti_2 \(95\.0%\)/);
});

test('quota alerts trigger expiring-soon reminder for unused quota within 4h threshold and 1h intervals', () => {
  const profiles = [
    { id: 'p1', label: 'anti_main', tool: 'antigravity', reportedAccount: 'main@test' },
  ];
  const now = Date.now();
  // 1. Resets in 6 hours: exceeds 4h threshold -> should not trigger
  const resetsAt6h = new Date(now + 6 * 3600 * 1000).toISOString();
  const history = new Set();
  const prev = new Map();
  const noAlert = evaluateQuotaAlerts(
    profiles,
    [{ profileId: 'p1', bucket: '3p-weekly', value: 80, unit: 'percent', metric: 'quota-remaining', resetsAt: resetsAt6h, observedAt: new Date(now).toISOString() }],
    history,
    prev,
    now,
  );
  assert.equal(noAlert.length, 0);

  // 2. Resets in 3 hours: within 4h threshold -> triggers
  const resetsAt3h = new Date(now + 3 * 3600 * 1000).toISOString();
  const alerts = evaluateQuotaAlerts(
    profiles,
    [{ profileId: 'p1', bucket: '3p-weekly', value: 80, unit: 'percent', metric: 'quota-remaining', resetsAt: resetsAt3h, observedAt: new Date(now).toISOString() }],
    history,
    prev,
    now,
  );

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'expiring-soon');
  assert.match(alerts[0].message, /80% Claude quota expiring in ~3h/);

  // 3. Second evaluation within 10 minutes -> throttled, returns no duplicate
  const second = evaluateQuotaAlerts(
    profiles,
    [{ profileId: 'p1', bucket: '3p-weekly', value: 80, unit: 'percent', metric: 'quota-remaining', resetsAt: resetsAt3h, observedAt: new Date(now + 10 * 60 * 1000).toISOString() }],
    history,
    prev,
    now + 10 * 60 * 1000,
  );
  assert.equal(second.length, 0);

  // 4. Re-evaluated after 1 hour (65 minutes later, still within 4h window) -> triggers again
  const after1h = evaluateQuotaAlerts(
    profiles,
    [{ profileId: 'p1', bucket: '3p-weekly', value: 80, unit: 'percent', metric: 'quota-remaining', resetsAt: resetsAt3h, observedAt: new Date(now + 65 * 60 * 1000).toISOString() }],
    history,
    prev,
    now + 65 * 60 * 1000,
  );
  assert.equal(after1h.length, 1);
  assert.equal(after1h[0].type, 'expiring-soon');
});

test('quota alerts ignore 5-hour rolling limits for expiring-soon reminder', () => {
  const profiles = [
    { id: 'p1', label: 'anti_main', tool: 'antigravity', reportedAccount: 'main@test' },
  ];
  const now = Date.now();
  const resetsAt2h = new Date(now + 2 * 3600 * 1000).toISOString();
  const history = new Set();
  const prev = new Map();

  const alerts = evaluateQuotaAlerts(
    profiles,
    [
      { profileId: 'p1', bucket: 'gemini-5h', value: 90, unit: 'percent', metric: 'quota-remaining', resetsAt: resetsAt2h, observedAt: new Date(now).toISOString() },
      { profileId: 'p1', bucket: '3p-5h', value: 95, unit: 'percent', metric: 'quota-remaining', resetsAt: resetsAt2h, observedAt: new Date(now).toISOString() },
    ],
    history,
    prev,
    now,
  );

  assert.equal(alerts.length, 0);
});

test('quota alerts trigger low-quota warning when remaining <= 15%', () => {
  const profiles = [
    { id: 'p1', label: 'anti_main', tool: 'antigravity', reportedAccount: 'main@test' },
  ];
  const now = Date.now();
  const resources = [
    {
      profileId: 'p1',
      bucket: 'gemini-weekly',
      value: 10,
      unit: 'percent',
      metric: 'quota-remaining',
      observedAt: new Date(now).toISOString(),
    },
  ];

  const history = new Set();
  const prev = new Map();
  const alerts = evaluateQuotaAlerts(profiles, resources, history, prev, now);

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'low-quota');
  assert.match(alerts[0].message, /is down to 10% remaining/);
});

test('quota alerts trigger reset alert when recovering from exhaustion', () => {
  const profiles = [
    { id: 'p1', label: 'anti_3', tool: 'antigravity', reportedAccount: 'user@test' },
  ];
  const now = Date.now();
  const history = new Set();
  const prev = new Map();

  // First cycle: exhausted at 0%
  evaluateQuotaAlerts(
    profiles,
    [
      {
        profileId: 'p1',
        bucket: 'gemini-weekly',
        value: 0,
        unit: 'percent',
        metric: 'quota-remaining',
        observedAt: new Date(now - 60000).toISOString(),
      },
    ],
    history,
    prev,
    now - 60000,
  );

  // Second cycle: quota refreshed to 100%
  const alerts = evaluateQuotaAlerts(
    profiles,
    [
      {
        profileId: 'p1',
        bucket: 'gemini-weekly',
        value: 100,
        unit: 'percent',
        metric: 'quota-remaining',
        resetsAt: new Date(now + 100 * 3600 * 1000).toISOString(),
        observedAt: new Date(now).toISOString(),
      },
    ],
    history,
    prev,
    now,
  );

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'reset');
  assert.match(alerts[0].message, /quota has refreshed \(100% remaining\)/);
});
