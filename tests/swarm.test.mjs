import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SwarmTaskSchema,
  SwarmDeploySchema,
  getSwarmStatus,
  cancelSwarm,
} from '../dist/management/swarm.js';

test('SwarmTaskSchema validates inputs and provides defaults', () => {
  const valid = SwarmTaskSchema.parse({
    task: 'Refactor authentication module',
  });
  assert.ok(valid.id.startsWith('task-'));
  assert.equal(valid.task, 'Refactor authentication module');
  assert.equal(valid.isolate_workspace, true);

  assert.throws(() => {
    SwarmTaskSchema.parse({ task: '' });
  }, /cannot be empty/);
});

test('SwarmDeploySchema validates options and constraints', () => {
  const valid = SwarmDeploySchema.parse({
    tasks: [{ task: 'Task 1' }, { task: 'Task 2' }],
  });
  assert.equal(valid.provider, 'antigravity');
  assert.equal(valid.wait_for_completion, true);
  assert.equal(valid.timeout_seconds, 300);
  assert.equal(valid.tasks.length, 2);

  assert.throws(() => {
    SwarmDeploySchema.parse({ tasks: [] });
  }, /at least one task/);
});

test('getSwarmStatus returns undefined for unknown swarm IDs', () => {
  assert.equal(getSwarmStatus('non-existent-swarm-id'), undefined);
});

test('cancelSwarm returns false for unknown swarm IDs', async () => {
  const cancelled = await cancelSwarm('non-existent-swarm-id');
  assert.equal(cancelled, false);
});
