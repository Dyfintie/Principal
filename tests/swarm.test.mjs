import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SwarmTaskSchema,
  SwarmDeploySchema,
} from '../dist/management/swarm.js';

test('SwarmTaskSchema validates inputs and provides defaults', () => {
  const valid = SwarmTaskSchema.parse({
    task: 'Refactor authentication module',
    profile_id: 'chosen-account',
    cwd: '/repository',
  });
  assert.equal(valid.id, undefined); // Manager assigns a deterministic ID from the batch request.
  assert.equal(valid.task, 'Refactor authentication module');
  assert.equal(valid.isolate_workspace, true);

  assert.throws(() => {
    SwarmTaskSchema.parse({ task: '', profile_id: 'chosen-account', cwd: '/repository' });
  });
});

test('SwarmDeploySchema validates options and constraints', () => {
  const valid = SwarmDeploySchema.parse({
    request_id: 'batch',
    tasks: [{ task: 'Task 1', profile_id: 'one', cwd: '/repo' }, { task: 'Task 2', profile_id: 'two', cwd: '/repo' }],
  });
  assert.equal(valid.provider, undefined);
  assert.equal(valid.wait_for_completion, false);
  assert.equal(valid.timeout_seconds, 300);
  assert.equal(valid.tasks.length, 2);

  assert.throws(() => {
    SwarmDeploySchema.parse({ request_id: 'empty', tasks: [] });
  }, /at least one task/);
});

test('unassigned and automatically routed tasks are rejected before dispatch', () => {
  assert.equal(SwarmTaskSchema.safeParse({ task: 'implicit' }).success, false);
  assert.equal(SwarmDeploySchema.safeParse({ request_id: 'auto', provider: 'auto', tasks: [{ profile_id: 'one', cwd: '/repo', task: 'x' }] }).success, false);
});

test('a blocking deployment is rejected in favor of asynchronous worker control', () => {
  assert.equal(SwarmDeploySchema.safeParse({ request_id: 'blocking', wait_for_completion: true, tasks: [{ profile_id: 'one', cwd: '/repo', task: 'x' }] }).success, false);
});
