import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deniedPermission,
  workspacePermissions,
  completedResult,
} from '../runtime/antigravity-permissions.mjs';
test('headless permission denial is recognized without bypassing policy', () => {
  assert.equal(deniedPermission('tool soft-denied in headless mode'), true);
  assert.equal(deniedPermission('command requires approval'), true);
  assert.equal(deniedPermission('permission denied'), true);
  assert.equal(deniedPermission('ordinary progress'), false);
});
test('workspace permissions grant only the mounted workspace and preserve denies', () => {
  const base = { allow: ['command(*)'], deny: ['write_file(/workspace)', 'mcp(*)'] };
  const read = workspacePermissions(base, false),
    write = workspacePermissions(base, true);
  assert.ok(!read.allow.includes('write_file(/workspace)'));
  assert.ok(write.allow.includes('write_file(/workspace)'));
  assert.deepEqual(write.deny, base.deny);
  assert.ok(!write.allow.includes('write_file(*)'));
});
test('native success with empty or timed-out partial output is not task completion', () => {
  assert.equal(completedResult(0, { status: 'SUCCESS', response: '' }, ''), false);
  assert.equal(
    completedResult(
      0,
      { status: 'SUCCESS', response: 'partial' },
      '[agy] print timeout after 1m0s with turn in progress; returning partial output',
    ),
    false,
  );
  assert.equal(
    completedResult(0, { status: 'SUCCESS', structured_output: { marker: 'fixture' } }, ''),
    true,
  );
  assert.equal(
    completedResult(0, { status: 'SUCCESS', response: 'done' }, 'permission denied'),
    false,
  );
  assert.equal(completedResult(1, { status: 'SUCCESS', response: 'done' }, ''), false);
});
