import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exec } from '../dist/util.js';
import { findExecutable } from '../dist/management/providers.js';
import {
  findGitRoot,
  hasGitHead,
  prepareWorkspace,
} from '../dist/management/worktree.js';

test('worktree correctly provisions isolated git worktree and collects diffs', async () => {
  const git = await findExecutable('git');
  if (!git) return;

  const root = await mkdtemp(path.join(tmpdir(), 'principal-wt-test-'));
  try {
    // Initialize temporary git repo
    await exec(git, ['init'], { cwd: root });
    await exec(git, ['config', 'user.name', 'test'], { cwd: root });
    await exec(git, ['config', 'user.email', 'test@test.local'], { cwd: root });

    assert.equal(await findGitRoot(root), root);
    assert.equal(await hasGitHead(root), false);

    // Create an initial commit so HEAD exists
    await writeFile(path.join(root, 'index.txt'), 'version 1\n');
    await exec(git, ['add', 'index.txt'], { cwd: root });
    await exec(git, ['commit', '-m', 'initial commit'], { cwd: root });

    assert.equal(await hasGitHead(root), true);

    // Prepare workspace for a task
    const session = await prepareWorkspace(root, 'task-alpha', true);
    assert.equal(session.isGitWorktree, true);
    assert.notEqual(session.worktreeDir, root);
    assert.ok(session.worktreeDir.includes('task-alpha'));

    // Modify a file in the worktree
    await writeFile(path.join(session.worktreeDir, 'index.txt'), 'version 2\n');
    // Add a new file in the worktree
    await writeFile(path.join(session.worktreeDir, 'created.txt'), 'new file content\n');

    // Ensure source directory is untouched
    const sourceContent = await exec(git, ['diff', 'HEAD'], { cwd: root });
    assert.equal(sourceContent.stdout.toString().trim(), '');

    // Collect diff from the worktree
    const diffReport = await session.getDiff();
    assert.ok(diffReport.diff.includes('diff --git a/index.txt b/index.txt'));
    assert.ok(diffReport.diff.includes('+version 2'));
    assert.ok(diffReport.diff.includes('diff --git a/created.txt b/created.txt'));
    assert.ok(diffReport.files.includes('index.txt'));
    assert.ok(diffReport.files.includes('created.txt'));

    // Clean up
    await session.cleanup();

    // Verify worktree list no longer includes the session worktree
    const listRes = await exec(git, ['worktree', 'list'], { cwd: root });
    assert.doesNotMatch(listRes.stdout.toString(), /task-alpha/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worktree isolate_workspace=false returns source directory directly without isolation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'principal-no-iso-test-'));
  try {
    const session = await prepareWorkspace(root, 'no-iso-task', false);
    assert.equal(session.isGitWorktree, false);
    assert.equal(session.worktreeDir, root);
    const diff = await session.getDiff();
    assert.deepEqual(diff, { diff: '', files: [] });
    await session.cleanup();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
