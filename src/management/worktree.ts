import { exec } from '../util.js';
import { findExecutable } from './providers.js';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface WorktreeSession {
  taskId: string;
  sourceDir: string;
  worktreeDir: string;
  isGitWorktree: boolean;
  branchName?: string;
  getDiff: () => Promise<{ diff: string; files: string[] }>;
  cleanup: () => Promise<void>;
}

export async function findGitRoot(directory: string): Promise<string | null> {
  const git = await findExecutable('git');
  if (!git) return null;
  const res = await exec(git, ['rev-parse', '--show-toplevel'], {
    cwd: directory,
    allowFailure: true,
  });
  if (res.code === 0) {
    const root = res.stdout.toString().trim();
    return root || null;
  }
  return null;
}

export async function hasGitHead(repoRoot: string): Promise<boolean> {
  const git = await findExecutable('git');
  if (!git) return false;
  const res = await exec(git, ['rev-parse', '--verify', 'HEAD'], {
    cwd: repoRoot,
    allowFailure: true,
  });
  return res.code === 0;
}

export async function prepareWorkspace(
  sourceDir: string,
  taskId: string,
  isolateWorkspace = true,
): Promise<WorktreeSession> {
  if (!isolateWorkspace) {
    return {
      taskId,
      sourceDir,
      worktreeDir: sourceDir,
      isGitWorktree: false,
      getDiff: async () => ({ diff: '', files: [] }),
      cleanup: async () => {},
    };
  }

  const git = await findExecutable('git');
  const repoRoot = git ? await findGitRoot(sourceDir) : null;
  const hasHead = repoRoot ? await hasGitHead(repoRoot) : false;

  const token = randomBytes(4).toString('hex');
  const cleanId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');

  if (git && repoRoot && hasHead) {
    const worktreesBase = path.join(repoRoot, '.git', 'principal-worktrees');
    await mkdir(worktreesBase, { recursive: true, mode: 0o700 });
    const worktreeDir = path.join(worktreesBase, `${cleanId}-${token}`);
    const branchName = `principal/swarm-${cleanId}-${token}`;

    const addRes = await exec(git, ['worktree', 'add', '-b', branchName, worktreeDir, 'HEAD'], {
      cwd: repoRoot,
      allowFailure: true,
    });

    if (addRes.code === 0) {
      return {
        taskId,
        sourceDir,
        worktreeDir,
        isGitWorktree: true,
        branchName,
        getDiff: async () => {
          // Add intent to add for untracked files so git diff HEAD captures them
          await exec(git, ['add', '-N', '.'], { cwd: worktreeDir, allowFailure: true });
          const diffRes = await exec(git, ['diff', 'HEAD'], {
            cwd: worktreeDir,
            allowFailure: true,
            maxBytes: 16 * 1024 * 1024,
          });
          const statusRes = await exec(git, ['status', '--porcelain'], {
            cwd: worktreeDir,
            allowFailure: true,
          });
          const files = statusRes.stdout
            .toString()
            .split('\n')
            .map((line) => line.slice(3).trim())
            .filter(Boolean);
          return {
            diff: diffRes.stdout.toString(),
            files,
          };
        },
        cleanup: async () => {
          await exec(git, ['worktree', 'remove', '--force', worktreeDir], {
            cwd: repoRoot,
            allowFailure: true,
          });
          await exec(git, ['branch', '-D', branchName], {
            cwd: repoRoot,
            allowFailure: true,
          });
          await exec(git, ['worktree', 'prune'], {
            cwd: repoRoot,
            allowFailure: true,
          });
          await rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
        },
      };
    }
  }

  // Fallback for non-git or unborn repos: isolated scratch directory copy
  const scratchDir = path.join(tmpdir(), `principal-swarm-${cleanId}-${token}`);
  await mkdir(scratchDir, { recursive: true, mode: 0o700 });
  
  // Shallow copy files excluding heavy or recursive directories
  await cp(sourceDir, scratchDir, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return !['node_modules', '.git', 'dist', '.gemini', '.cache'].includes(base);
    },
  }).catch(() => {});

  return {
    taskId,
    sourceDir,
    worktreeDir: scratchDir,
    isGitWorktree: false,
    getDiff: async () => {
      // In scratch mode without git, try git diff if git is present
      if (git) {
        await exec(git, ['init'], { cwd: scratchDir, allowFailure: true });
      }
      return { diff: '', files: [] };
    },
    cleanup: async () => {
      await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
