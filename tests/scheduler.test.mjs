import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAccount } from '../dist/scheduler.js';
import { classifyFailure, headroom } from '../dist/providers/quota.js';
import { ConfigSchema } from '../dist/schema.js';
const config = ConfigSchema.parse({});
const accounts = ['a', 'b'].map((id) => ({
  id,
  label: `free-${id}`,
  provider: 'codex',
  status: 'ready',
  model: 'm',
  lastAssigned: 0,
}));
const task = { spec: { account: 'free-a', allowFallback: false }, attempts: 0 };
const quota = () => ({
  state: 'reported',
  observedAt: new Date().toISOString(),
  buckets: [{ remainingPercent: 99, models: [], scopeKnown: true }],
});
test('pinned task stays on selected account', () =>
  assert.equal(selectAccount(task, accounts, quota, new Set(), config)?.id, 'a'));
test('busy pinned account cannot fall through to other account', () =>
  assert.equal(selectAccount(task, accounts, quota, new Set(['a']), config), null));
test('unknown quota requires explicit opt in', () => {
  assert.equal(
    selectAccount(task, accounts, () => null, new Set(), config),
    null,
  );
  assert.equal(
    selectAccount(
      task,
      accounts,
      () => null,
      new Set(),
      ConfigSchema.parse({ routing: { allowUnknownQuota: true } }),
    )?.id,
    'a',
  );
});
test('reserve blocks exhausted allowance', () =>
  assert.equal(
    selectAccount(
      task,
      accounts,
      () => ({ ...quota(), buckets: [{ remainingPercent: 10, models: [] }] }),
      new Set(),
      config,
    ),
    null,
  ));
test('unknown model membership stays unknown', () =>
  assert.equal(
    headroom(
      { ...quota(), buckets: [{ remainingPercent: 100, models: [], scopeKnown: false }] },
      'm',
    ),
    null,
  ));
test('sandbox failure summary does not become a quota handoff', () => {
  const report = {
    summary: 'Could not read documents because bubblewrap is unavailable.',
    remainingIssues: ['Compare quota-aware handoff in other tools'],
  };
  assert.equal(classifyFailure(report.summary), 'failed');
  assert.equal(classifyFailure(JSON.stringify(report)), 'quota');
});
test('provider default model conservatively uses every reported bucket with unknown membership',()=>{
  const q={state:'reported',buckets:[{remainingPercent:88,models:[],scopeKnown:false},{remainingPercent:12,models:[],scopeKnown:false}]};
  assert.equal(headroom(q),12);assert.equal(headroom(q,'pinned-model'),null);
  assert.equal(headroom({...q,buckets:[...q.buckets,{remainingPercent:null,models:[],scopeKnown:false}]}),null);
});
