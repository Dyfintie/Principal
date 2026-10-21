import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { exec } from '../util.js';
import type { WorkerWorkspace } from './worker-model.js';

// An alternate index captures untracked files without touching the worker's index.
export async function captureWorkerWorkspace(workspace: WorkerWorkspace) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'principal-index-'));
  const options = {
    cwd: workspace.worktreeDir,
    env: { ...process.env, GIT_INDEX_FILE: path.join(temporary, 'index') },
    maxBytes: 64 * 1024 * 1024,
  };
  try {
    await exec('git', ['read-tree', workspace.baseRevision], options);
    await exec('git', ['add', '-A', '--', '.'], options);
    const diff = await exec('git', ['diff', '--cached', '--binary', '--full-index', workspace.baseRevision, '--'], options);
    const names = await exec('git', ['diff', '--cached', '--name-only', '-z', workspace.baseRevision, '--'], options);
    return { diff: diff.stdout.toString(), files: names.stdout.toString().split('\0').filter(Boolean) };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function createWorkerWorkspace(sourceDir: string, id: string, prepared?: (workspace: WorkerWorkspace) => void): Promise<WorkerWorkspace> {
  const cwd = { cwd: sourceDir };
  const repoRoot = (await exec('git', ['rev-parse', '--show-toplevel'], cwd)).stdout.toString().trim();
  const common = (await exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)).stdout.toString().trim();
  const baseRevision = (await exec('git', ['rev-parse', '--verify', 'HEAD^{commit}'], cwd)).stdout.toString().trim();
  const sourceDirty = (await exec('git', ['status', '--porcelain', '-z'], cwd)).stdout.length > 0;
  const branchName = `principal/worker-${id}`;
  const worktreeDir = path.join(common, 'principal-worktrees', `worker-${id}`);
  const workspace = { sourceDir, repoRoot, worktreeDir, workingDir: path.join(worktreeDir, path.relative(repoRoot, sourceDir)), branchName, baseRevision, sourceDirty };
  // Persist ownership before Git creates anything, including across daemon loss.
  prepared?.(workspace);
  await exec('git', ['worktree', 'add', '-b', branchName, worktreeDir, baseRevision], { cwd: repoRoot });
  return workspace;
}

export async function releaseWorkerWorkspace(workspace: WorkerWorkspace) {
  // Only this exact branch/path pair may be removed. Do not prune other worktrees.
  const trees = (await exec('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: workspace.repoRoot })).stdout.toString();
  const entry = trees.split('\0\0').find((value) => value.startsWith(`worktree ${workspace.worktreeDir}\0`));
  if (entry && !entry.split('\0').includes(`branch refs/heads/${workspace.branchName}`))
    throw new Error('Worker worktree ownership changed; cleanup blocked');
  if (entry) await exec('git', ['worktree', 'remove', '--force', workspace.worktreeDir], { cwd: workspace.repoRoot });
  const exists = await exec('git', ['show-ref', '--verify', '--quiet', `refs/heads/${workspace.branchName}`], { cwd: workspace.repoRoot, allowFailure: true });
  if (exists.code === 0) await exec('git', ['branch', '-D', workspace.branchName], { cwd: workspace.repoRoot });
}
