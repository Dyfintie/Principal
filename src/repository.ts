import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, lstat, realpath } from 'node:fs/promises';
import { minimatch } from 'minimatch';
import { exec, paths, atomicWrite } from './util.js';
import type { Run, TaskRecord } from './schema.js';
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};
export async function git(repo: string, args: string[], input?: Buffer | string) {
  return exec(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.autocrlf=false',
      '-c',
      'commit.gpgSign=false',
      ...args,
    ],
    { cwd: repo, input, env: gitEnv, timeout: 60000 },
  );
}
export async function cleanRepository(directory: string) {
  const repo = (await git(directory, ['rev-parse', '--show-toplevel'])).stdout.toString().trim();
  if ((await git(repo, ['status', '--porcelain', '--untracked-files=all'])).stdout.length)
    throw new Error(
      'Repository must be clean and committed. Commit or remove local changes before starting.',
    );
  return {
    repo: await realpath(repo),
    base: (await git(repo, ['rev-parse', 'HEAD'])).stdout.toString().trim(),
  };
}
export class Repository {
  private async validateModes(repo: string, args: string[]) {
    const raw = (await git(repo, [...args, '--raw', '--no-renames', '-z'])).stdout.toString();
    const fields = raw.split('\0');
    for (let i = 0; i < fields.length - 1; i += 2) {
      const mode = fields[i].split(' ')[1];
      this.validatePath(fields[i + 1]);
      if (!['000000', '100644', '100755'].includes(mode))
        throw new Error(`Disallowed non-regular artifact: ${fields[i + 1]}`);
    }
  }
  private validatePath(file: string) {
    const parts = file.split('/');
    if (
      file === 'principal.config.json' ||
      parts.some((part) => ['AGENTS.md', 'CLAUDE.md', '.codex', '.gemini'].includes(part)) ||
      path.isAbsolute(file) ||
      parts.some((part) => ['..', '.git', '.gitmodules', '.gitattributes'].includes(part))
    )
      throw new Error(`Disallowed artifact path ${file}`);
  }
  runDir(id: string) {
    return path.join(paths.runs, id);
  }
  async prepare(run: Run) {
    const dir = this.runDir(run.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await git(run.repo, ['bundle', 'create', path.join(dir, 'base.bundle'), 'HEAD']);
  }
  private async clone(run: Run, target: string) {
    await git(this.runDir(run.id), [
      'clone',
      '--quiet',
      '--no-hardlinks',
      path.join(this.runDir(run.id), 'base.bundle'),
      target,
    ]);
    await git(target, ['checkout', '--quiet', '--detach', run.base]);
  }
  dependencies(task: TaskRecord, tasks: TaskRecord[]) {
    const found = new Set<string>();
    const visit = (id: string) => {
      const t = tasks.find((x) => x.id === id)!;
      for (const d of t.spec.dependsOn) visit(d);
      found.add(id);
    };
    for (const d of task.spec.dependsOn) visit(d);
    return [...found];
  }
  async workspace(run: Run, task: TaskRecord, attemptId: string, tasks: TaskRecord[]) {
    const target = path.join(this.runDir(run.id), 'attempts', attemptId, 'workspace');
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await this.clone(run, target);
    for (const id of this.dependencies(task, tasks)) {
      const dep = tasks.find((x) => x.id === id)!;
      if (dep.checkpoint) await this.applyPatch(target, await this.readPatch(dep));
    }
    if (task.checkpoint) await this.applyPatch(target, await this.readPatch(task));
    return target;
  }
  async readPatch(task: TaskRecord) {
    if (!task.checkpoint) return Buffer.alloc(0);
    const patch = await readFile(task.checkpoint);
    if (
      task.checkpointHash &&
      createHash('sha256').update(patch).digest('hex') !== task.checkpointHash
    )
      throw new Error(`Checkpoint integrity mismatch for ${task.id}`);
    return patch;
  }
  async applyPatch(workspace: string, patch: Buffer) {
    if (patch.length) {
      await git(workspace, ['apply', '--index', '--binary', '--whitespace=nowarn', '-'], patch);
      await this.validateModes(workspace, ['diff', '--cached']);
    }
  }
  async checkpoint(
    run: Run,
    task: TaskRecord,
    attemptId: string,
    workspace: string,
    tasks: TaskRecord[],
  ) {
    // Worker .git metadata is untrusted. Use an independent coordinator-owned index and config.
    const trusted = path.join(this.runDir(run.id), 'attempts', attemptId, 'trusted');
    await rm(trusted, { recursive: true, force: true });
    await this.clone(run, trusted);
    for (const id of this.dependencies(task, tasks)) {
      const dep = tasks.find((x) => x.id === id)!;
      if (dep.checkpoint) await this.applyPatch(trusted, await this.readPatch(dep));
    }
    await git(trusted, [
      '-c',
      'user.name=Principal',
      '-c',
      'user.email=principal@localhost',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'Dependency snapshot',
    ]);
    const baseline = (await git(trusted, ['rev-parse', 'HEAD'])).stdout.toString().trim();
    await git(trusted, ['--work-tree', workspace, 'add', '--all', '--', '.']);
    await this.validateModes(trusted, ['diff', '--cached', baseline]);
    const files = (await git(trusted, ['diff', '--cached', '--name-only', '-z', baseline])).stdout
      .toString()
      .split('\0')
      .filter(Boolean);
    for (const file of files) {
      this.validatePath(file);
      if (
        task.spec.mode === 'read' ||
        !task.spec.writePaths.some((p) => minimatch(file, p, { dot: true }))
      )
        throw new Error(`Task ${task.id} changed disallowed path ${file}`);
      try {
        const s = await lstat(path.join(workspace, file));
        if (!s.isFile()) throw new Error(`Disallowed non-regular artifact: ${file}`);
        if (s.size > 16 * 1024 * 1024) throw new Error(`Artifact too large: ${file}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    const patch = (await git(trusted, ['diff', '--cached', '--binary', baseline])).stdout;
    if (patch.length > 32 * 1024 * 1024) throw new Error('Patch exceeds 32 MiB limit');
    const file = path.join(this.runDir(run.id), 'attempts', attemptId, 'checkpoint.patch');
    await atomicWrite(file, patch);
    return {
      file,
      files,
      bytes: patch.length,
      hash: createHash('sha256').update(patch).digest('hex'),
    };
  }
  async integrate(run: Run, tasks: TaskRecord[], base?: string) {
    const target = path.join(this.runDir(run.id), 'integration');
    await rm(target, { recursive: true, force: true });
    await this.clone(run, target);
    if (base && base !== run.base) {
      await git(target, ['fetch', '--quiet', run.repo, base]);
      await git(target, ['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
    }
    const done = new Set<string>();
    while (done.size < tasks.length) {
      let progress = false;
      for (const t of tasks) {
        if (done.has(t.id) || !t.spec.dependsOn.every((id) => done.has(id))) continue;
        if (t.status !== 'completed') throw new Error(`Task ${t.id} has not completed`);
        if (t.checkpoint) await this.applyPatch(target, await this.readPatch(t));
        await git(target, [
          '-c',
          'user.name=Principal',
          '-c',
          'user.email=principal@localhost',
          'commit',
          '--quiet',
          '--allow-empty',
          '-m',
          `Principal ${run.id}: ${t.id}`,
        ]);
        done.add(t.id);
        progress = true;
      }
      if (!progress) throw new Error('Dependency graph cannot be integrated');
    }
    return {
      workspace: target,
      commit: (await git(target, ['rev-parse', 'HEAD'])).stdout.toString().trim(),
    };
  }
  async diff(run: Run) {
    if (!run.integration) throw new Error('No integration available');
    return (await git(run.integration, ['diff', '--stat', run.base, 'HEAD'])).stdout.toString();
  }
  async apply(run: Run) {
    if (
      run.status !== 'ready_for_review' ||
      !run.integration ||
      !run.integrationCommit ||
      run.checkedCommit !== run.integrationCommit
    )
      throw new Error('Run must be validated and ready for review');
    const current = await cleanRepository(run.repo);
    if (current.base === run.integrationCommit) return;
    if (current.base !== run.base)
      throw new Error('Original branch changed; reintegrate against the new base and review again');
    // Fetch the exact reviewed commit. Disable host hooks for the fast-forward.
    await git(run.repo, ['fetch', '--quiet', run.integration, run.integrationCommit]);
    await this.validateModes(run.repo, ['diff', run.base, run.integrationCommit]);
    await git(run.repo, ['merge', '--ff-only', run.integrationCommit]);
  }
}
