import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  rm,
  lstat,
  realpath,
  copyFile,
  chmod,
  rename,
  open,
} from 'node:fs/promises';
import { git } from './repository.js';
import { atomicWrite, paths, uid, exec } from './util.js';
import type { Session } from './session-types.js';
async function syncDirectory(directory: string) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
const digest = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
function safe(file: string) {
  if (
    path.isAbsolute(file) ||
    file.split('/').some((p) => ['..', '.git', '.gitmodules', '.gitattributes'].includes(p))
  )
    throw new Error(`Unsafe session artifact ${file}`);
}
async function files(repo: string, directoryMode = false) {
  if (directoryMode) {
    const inventory = path.join(paths.state, 'directory-inventory.git');
    await mkdir(inventory, { recursive: true, mode: 0o700 });
    await git(inventory, ['init', '--bare', '--quiet']);
    const result = await exec(
      'git',
      [
        `--git-dir=${inventory}`,
        `--work-tree=${repo}`,
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
        ...[
          '.git/',
          'node_modules/',
          '.ssh/',
          '.gnupg/',
          '.codex/',
          '.gemini/',
          '.cache/',
          '.local/',
          '.config/',
        ].map((x) => `--exclude=${x}`),
      ],
      { cwd: repo },
    );
    return result.stdout.toString().split('\0').filter(Boolean).sort();
  }
  return [
    ...new Set(
      [
        ...(
          await git(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
        ).stdout
          .toString()
          .split('\0'),
        ...(await git(repo, ['ls-tree', '-r', '--name-only', '-z', 'HEAD'])).stdout
          .toString()
          .split('\0'),
      ].filter(Boolean),
    ),
  ].sort();
}
// Conversation startup never scans or changes a non-repository directory.
export async function initialWorkspace(directory: string, id: string) {
  const repo = await realpath(directory);
  if (!(await lstat(repo)).isDirectory()) throw new Error('Working area must be a directory');
  let committedRoot = false;
  try {
    const root = await realpath(
      (await git(repo, ['rev-parse', '--show-toplevel'])).stdout.toString().trim(),
    );
    await git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
    committedRoot = root === repo;
  } catch {}
  if (committedRoot) return capture(repo, id);
  return {
    repo,
    workspace: repo,
    baseline: '',
    hostFingerprint: '',
    directoryMode: true,
    liveDirectory: true,
  };
}
export async function hostState(directory: string, directoryMode = false) {
  if (directoryMode) return directoryState(directory);
  let repo: string;
  try {
    repo = await realpath(
      (await git(directory, ['rev-parse', '--show-toplevel'])).stdout.toString().trim(),
    );
  } catch {
    throw new Error(
      `Principal needs a Git project. Run principal from your project's directory (${directory} is not a usable Git repository).`,
    );
  }
  let head: string;
  try {
    head = (await git(repo, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.toString().trim();
  } catch {
    throw new Error(
      `Principal needs a repository with at least one commit. ${repo} has no usable HEAD. Run principal from an existing committed project, or create an initial commit containing only the intended project files.`,
    );
  }
  if ((await git(repo, ['ls-files', '--unmerged', '-z'])).stdout.length)
    throw new Error('Unresolved merges are unsupported');
  const entries = (await git(repo, ['ls-files', '--stage', '-z'])).stdout.toString().split('\0');
  if (entries.some((x) => x.startsWith('160000 ')))
    throw new Error('Populated submodule workspaces are unsupported');
  const indexPath = (await git(repo, ['rev-parse', '--git-path', 'index'])).stdout
    .toString()
    .trim();
  const indexHash = digest(await readFile(path.resolve(repo, indexPath)));
  const manifest: { file: string; hash: string | null; mode: number | null }[] = [];
  for (const file of await files(repo)) {
    safe(file);
    try {
      let parent = path.dirname(path.join(repo, file));
      while (parent !== repo) {
        const st = await lstat(parent);
        if (!st.isDirectory()) throw new Error(`Unsafe baseline ancestor ${parent}`);
        parent = path.dirname(parent);
      }
      const st = await lstat(path.join(repo, file));
      if (!st.isFile()) throw new Error(`Non-regular baseline file ${file}`);
      if (st.size > 16 * 1024 * 1024) throw new Error(`Baseline file exceeds 16 MiB: ${file}`);
      manifest.push({
        file,
        hash: digest(await readFile(path.join(repo, file))),
        mode: st.mode & 0o111 ? 0o755 : 0o644,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      manifest.push({ file, hash: null, mode: null });
    }
  }
  return {
    repo,
    head,
    indexHash,
    manifest,
    fingerprint: digest(JSON.stringify({ head, indexHash, manifest })),
  };
}
async function directoryState(directory: string) {
  const repo = await realpath(directory);
  const manifest: { file: string; hash: string | null; mode: number | null }[] = [];
  for (const file of await files(repo, true)) {
    safe(file);
    let parent = path.dirname(path.join(repo, file));
    while (parent !== repo) {
      if (!(await lstat(parent)).isDirectory())
        throw new Error(`Unsafe baseline ancestor ${parent}`);
      parent = path.dirname(parent);
    }
    const st = await lstat(path.join(repo, file));
    if (!st.isFile()) throw new Error(`Non-regular baseline file ${file}`);
    if (st.size > 16 * 1024 * 1024) throw new Error(`Baseline file exceeds 16 MiB: ${file}`);
    manifest.push({
      file,
      hash: digest(await readFile(path.join(repo, file))),
      mode: st.mode & 0o111 ? 0o755 : 0o644,
    });
  }
  // Track an enclosing Git index as well, without requiring or creating a commit.
  let head = '',
    indexHash = '';
  try {
    head = (await git(repo, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.toString().trim();
  } catch {}
  try {
    const indexPath = (await git(repo, ['rev-parse', '--git-path', 'index'])).stdout
      .toString()
      .trim();
    indexHash = digest(await readFile(path.resolve(repo, indexPath)));
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
      (error as Error).message.indexOf('git failed') < 0
    )
      throw error;
  }
  return {
    repo,
    head,
    indexHash,
    manifest,
    fingerprint: digest(JSON.stringify({ head, indexHash, manifest })),
  };
}
async function commit(repo: string, message: string) {
  await git(repo, ['add', '--all']);
  await git(repo, [
    '-c',
    'user.name=Principal',
    '-c',
    'user.email=principal@localhost',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    message,
  ]);
  return (await git(repo, ['rev-parse', 'HEAD'])).stdout.toString().trim();
}
export async function capture(directory: string, id: string, directoryMode = false) {
  const root = path.join(paths.state, 'sessions', id);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const workspace = path.join(root, 'workspace');
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await hostState(directory, directoryMode);
    await rm(workspace, { recursive: true, force: true });
    if (directoryMode) {
      await mkdir(workspace, { recursive: true });
      await git(workspace, ['init', '--quiet']);
    } else {
      await git(before.repo, ['clone', '--quiet', '--no-hardlinks', '--', before.repo, workspace]);
      await git(workspace, ['checkout', '--quiet', '--detach', before.head]);
    }
    for (const entry of before.manifest) {
      const target = path.join(workspace, entry.file);
      if (entry.hash === null) {
        await rm(target, { force: true });
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(before.repo, entry.file), target);
      await chmod(target, entry.mode!);
    }
    const after = await hostState(directory, directoryMode);
    if (before.fingerprint !== after.fingerprint) continue;
    const live = before.manifest.filter((e) => e.hash !== null).map((e) => e.file);
    // Include staged additions even when the captured ignore rules now ignore them.
    for (let offset = 0; offset < live.length; offset += 100)
      await git(workspace, ['add', '--force', '--', ...live.slice(offset, offset + 100)]);
    const baseline = await commit(workspace, 'Captured user workspace');
    return {
      repo: before.repo,
      workspace,
      baseline,
      hostFingerprint: before.fingerprint,
      ...(directoryMode ? { directoryMode: true, liveDirectory: false } : {}),
    };
  }
  await rm(workspace, { recursive: true, force: true });
  throw new Error('Workspace changed during both capture attempts; retry when host writes settle');
}
export async function review(s: Session) {
  if (s.liveDirectory)
    return { version: s.workspaceVersion, hash: digest(''), patch: '', stat: '' };
  const patch = (await git(s.workspace, ['diff', '--binary', s.baseline, 'HEAD'])).stdout;
  return {
    version: s.workspaceVersion,
    hash: digest(patch),
    patch: patch.toString(),
    stat: (await git(s.workspace, ['diff', '--stat', s.baseline, 'HEAD'])).stdout.toString(),
  };
}
export async function apply(s: Session) {
  if (s.liveDirectory) throw new Error('No agent changes to apply');
  const r = await review(s);
  if (s.reviewedVersion !== s.workspaceVersion || s.reviewedHash !== r.hash)
    throw new Error('Review the current workspace version before applying');
  if ((await hostState(s.repo, s.directoryMode)).fingerprint !== s.hostFingerprint)
    throw new Error('Host drift detected; refresh and review again');
  const raw = (
    await git(s.workspace, ['diff', '--raw', '--no-renames', '-z', s.baseline, 'HEAD'])
  ).stdout
    .toString()
    .split('\0');
  const changed: string[] = [];
  for (let i = 0; i < raw.length - 1; i += 2) {
    safe(raw[i + 1]);
    if (raw[i + 1] === 'principal.config.json')
      throw new Error('Worker changes to operational configuration cannot be applied');
    if (!['000000', '100644', '100755'].includes(raw[i].split(' ')[1]))
      throw new Error('Unsafe artifact mode');
    changed.push(raw[i + 1]);
  }
  const root = path.join(paths.state, 'sessions', s.id, 'apply');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const journalFile = path.join(root, 'journal.json');
  try {
    await readFile(journalFile);
    throw new Error('An apply journal already exists; recover before applying');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const entries: {
    file: string;
    backup: string | null;
    mode: number | null;
    beforeHash: string | null;
    afterHash: string | null;
  }[] = [];
  for (const file of changed) {
    const target = path.join(s.repo, file);
    // Check every ancestor: an agent add must never follow an ignored host symlink.
    let ancestor = path.dirname(target);
    while (ancestor !== s.repo) {
      const st = await lstat(ancestor).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
        return null;
      });
      if (st && !st.isDirectory()) throw new Error(`Unsafe host ancestor ${ancestor}`);
      ancestor = path.dirname(ancestor);
    }
    const st = await lstat(target).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
      return null;
    });
    if (st && !st.isFile()) throw new Error(`Unsafe host target ${file}`);
    // Ignored files are absent from the captured manifest: never overwrite them.
    if (st && !(await files(s.repo, s.directoryMode)).includes(file))
      throw new Error(`Uncaptured host file ${file}`);
    const backup = st ? path.join(root, uid()) : null;
    if (backup) await atomicWrite(backup, await readFile(target));
    const tree = (await git(s.workspace, ['ls-tree', 'HEAD', '--', file])).stdout;
    const afterHash = tree.length
      ? digest((await git(s.workspace, ['show', `HEAD:${file}`])).stdout)
      : null;
    entries.push({
      file,
      backup,
      mode: st ? st.mode & 0o777 : null,
      beforeHash: st ? digest(await readFile(target)) : null,
      afterHash,
    });
  }
  await atomicWrite(
    journalFile,
    JSON.stringify({
      state: 'replacing',
      entries,
      baseline: s.hostFingerprint,
      head: (await hostState(s.repo, s.directoryMode)).head,
      indexHash: (await hostState(s.repo, s.directoryMode)).indexHash,
    }),
  );
  try {
    if ((await hostState(s.repo, s.directoryMode)).fingerprint !== s.hostFingerprint)
      throw new Error('Host changed before replacement');
    for (const e of entries) {
      const existing = await readFile(path.join(s.repo, e.file)).catch((err) => {
        if (err.code !== 'ENOENT') throw err;
        return null;
      });
      if ((existing ? digest(existing) : null) !== e.beforeHash)
        throw new Error(`Host changed during apply: ${e.file}`);
      const content = await git(s.workspace, ['ls-tree', 'HEAD', '--', e.file]);
      const target = path.join(s.repo, e.file);
      if (!content.stdout.length) {
        await rm(target, { force: true });
        await syncDirectory(path.dirname(target));
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.principal-${uid()}`;
      await atomicWrite(
        temp,
        (await git(s.workspace, ['show', `HEAD:${e.file}`])).stdout,
        content.stdout.toString().startsWith('100755') ? 0o755 : 0o644,
      );
      await rename(temp, target);
      await syncDirectory(path.dirname(target));
    }
    const next = await hostState(s.repo, s.directoryMode);
    const original = JSON.parse(await readFile(journalFile, 'utf8'));
    if (next.head !== original.head || next.indexHash !== original.indexHash)
      throw new Error('HEAD or index changed concurrently during apply');
    // Persist completion before cleanup, so a crash cannot cause a successful apply to be rolled back.
    await atomicWrite(
      journalFile,
      JSON.stringify({
        state: 'completed',
        entries,
        hostFingerprint: next.fingerprint,
        baseline: (await git(s.workspace, ['rev-parse', 'HEAD'])).stdout.toString().trim(),
      }),
    );
    return {
      hostFingerprint: next.fingerprint,
      baseline: (await git(s.workspace, ['rev-parse', 'HEAD'])).stdout.toString().trim(),
    };
  } catch (e) {
    await recoverApply(s);
    throw e;
  }
}
export async function recoverApply(s: Session) {
  const root = path.join(paths.state, 'sessions', s.id, 'apply');
  let journal;
  try {
    journal = JSON.parse(await readFile(path.join(root, 'journal.json'), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  if (journal.state !== 'completed') {
    for (const e of [...journal.entries].reverse()) {
      safe(e.file);
      const target = path.join(s.repo, e.file);
      let parent = path.dirname(target);
      while (parent !== s.repo) {
        const st = await lstat(parent).catch((err) => {
          if (err.code !== 'ENOENT') throw err;
          return null;
        });
        if (st && !st.isDirectory()) throw new Error(`Unsafe recovery ancestor ${parent}`);
        parent = path.dirname(parent);
      }
      const st = await lstat(target).catch((err) => {
        if (err.code !== 'ENOENT') throw err;
        return null;
      });
      if (st && !st.isFile()) throw new Error(`Unsafe recovery target ${e.file}`);
      const current = st ? digest(await readFile(target)) : null;
      if (e.beforeHash !== undefined && current !== e.beforeHash && current !== e.afterHash)
        throw new Error(`Recovery paused for host drift: ${e.file}`);
      if (e.backup) {
        const backup = await readFile(e.backup);
        if (e.beforeHash !== undefined && digest(backup) !== e.beforeHash)
          throw new Error(`Apply backup integrity mismatch: ${e.file}`);
        await mkdir(path.dirname(target), { recursive: true });
        await atomicWrite(target, backup, e.mode);
      } else await rm(target, { force: true });
      await syncDirectory(path.dirname(target));
    }
  }
  await rm(root, { recursive: true, force: true });
  return journal.state === 'completed'
    ? { hostFingerprint: journal.hostFingerprint, baseline: journal.baseline }
    : null;
}
export async function refreshWorkspace(s: Session) {
  if (s.liveDirectory)
    return { repo: s.repo, workspace: s.repo, baseline: '', hostFingerprint: '' };
  const patch = (await git(s.workspace, ['diff', '--binary', s.baseline, 'HEAD'])).stdout;
  const next = await capture(s.repo, `${s.id}-refresh-${uid()}`, s.directoryMode);
  try {
    if (patch.length) await git(next.workspace, ['apply', '--index', '--binary', '-'], patch);
    await commit(next.workspace, 'Reconciled agent changes');
    return next;
  } catch (e) {
    await rm(path.dirname(next.workspace), { recursive: true, force: true });
    throw new Error(`Refresh conflicts with private changes: ${(e as Error).message}`);
  }
}
