import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRemainingPercent } from '../dist/presentation.js';
import { codexQuota, agyQuota } from '../dist/providers/quota.js';
test('percentages consistently display two decimals', () => {
  assert.equal(formatRemainingPercent(87), '87.00% remaining');
  assert.equal(formatRemainingPercent(87.126), '87.13% remaining');
  assert.equal(formatRemainingPercent(1.005), '1.01% remaining');
  assert.equal(formatRemainingPercent(0), '0.00% remaining');
  assert.equal(formatRemainingPercent(100), '100.00% remaining');
});
test('missing or invalid percentages stay unknown', () => {
  for (const value of [null, undefined, NaN, Infinity, -1, 101])
    assert.equal(formatRemainingPercent(value), 'unknown');
});
test('Codex parsing retains fractional precision before formatting', () => {
  const quota = codexQuota('a', { rateLimits: { primary: { usedPercent: 12.3456 } } });
  const value = quota.buckets[0].remainingPercent;
  assert(Math.abs(value - 87.6544) < 1e-10);
  assert.equal(formatRemainingPercent(value), '87.65% remaining');
});
test('Antigravity parsing retains fractional precision before formatting', () => {
  const quota = agyQuota('a', {
    command: {
      data: { groups: [{ models: ['m'], buckets: [{ remaining_fraction: 0.87654321 }] }] },
    },
  });
  const value = quota.buckets[0].remainingPercent;
  assert(Math.abs(value - 87.654321) < 1e-10);
  assert.equal(formatRemainingPercent(value), '87.65% remaining');
});
