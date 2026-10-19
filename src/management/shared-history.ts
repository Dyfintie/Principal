import { copyFile, cp, lstat, readdir, readlink, realpath, rm, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { defaultDirectory } from './providers.js';
import { managementPaths, privateDirectory } from './paths.js';
import type { Installation, Profile } from './model.js';

/**
 * Checks whether a resolved canonical path is located inside an authorized
 * shared history root or management profile directory.
 */
export function isAllowedHistoryPath(resolvedPath: string): boolean {
  try {
    const allowedRoots = [
      defaultDirectory('antigravity'),
      defaultDirectory('codex'),
      managementPaths.profiles,
      managementPaths.state,
    ];
    return allowedRoots.some(
      (root) => resolvedPath === root || resolvedPath.startsWith(root + path.sep),
    );
  } catch {
    return false;
  }
}

function isFixtureInstallation(installation?: Installation): boolean {
  if (!installation) return false;
  if (installation.version === 'fixture') return true;
  if (installation.capabilities?.launch?.reason === 'fixture') return true;
  if (installation.capabilities?.observer?.reason === 'fixture') return true;
  if (installation.executable && installation.executable.includes('fake-')) return true;
  return false;
}

/**
 * Links a profile's directory to the common system conversation history.
 * Ensures that accounts share the common system history by default,
 * so all modifications are immediately visible across accounts without
 * duplicating files or creating race conditions.
 */
export async function ensureSharedHistory(
  profile: Profile,
  installation?: Installation,
): Promise<void> {
  if (!profile.isolated || profile.sharedHistory === false) return;
  if (isFixtureInstallation(installation)) return;
  if (profile.tool === 'antigravity') {
    await ensureAntigravitySharedHistory(profile);
  } else if (profile.tool === 'codex') {
    await ensureCodexSharedHistory(profile);
  }
}

async function ensureAntigravitySharedHistory(profile: Profile): Promise<void> {
  const systemRoot = defaultDirectory('antigravity');
  await privateDirectory(systemRoot);

  const sharedDirs = ['conversations', 'brain', 'annotations'];
  for (const d of sharedDirs) {
    await privateDirectory(path.join(systemRoot, d));
  }

  const targetRoot = profile.directory;
  await privateDirectory(targetRoot);

  for (const dirName of sharedDirs) {
    const sourceDir = path.join(systemRoot, dirName);
    const targetDir = path.join(targetRoot, dirName);
    await linkSharedDir(sourceDir, targetDir);
  }

  const sourceDb = path.join(systemRoot, 'conversation_summaries.db');
  const targetDb = path.join(targetRoot, 'conversation_summaries.db');
  await linkSharedSqliteDb(sourceDb, targetDb, 'conversation_summaries');

  const sourceHistory = path.join(systemRoot, 'history.jsonl');
  const targetHistory = path.join(targetRoot, 'history.jsonl');
  await linkSharedFile(sourceHistory, targetHistory);
}

async function ensureCodexSharedHistory(profile: Profile): Promise<void> {
  const systemRoot = defaultDirectory('codex');
  await privateDirectory(systemRoot);

  const sharedDirs = ['sessions', 'archived_sessions', 'skills'];
  for (const d of sharedDirs) {
    await privateDirectory(path.join(systemRoot, d));
  }

  const targetRoot = profile.directory;
  await privateDirectory(targetRoot);

  for (const dirName of sharedDirs) {
    await linkSharedDir(path.join(systemRoot, dirName), path.join(targetRoot, dirName));
  }

  const sharedFiles = [
    'history.jsonl',
    'session_index.jsonl',
    'state_5.sqlite',
    'memories_1.sqlite',
    'thread_history_1.sqlite',
    'models_cache.json',
  ];

  for (const fileName of sharedFiles) {
    await linkSharedFile(path.join(systemRoot, fileName), path.join(targetRoot, fileName));
  }
}

async function linkSharedDir(sourceDir: string, targetDir: string): Promise<void> {
  try {
    const st = await lstat(targetDir);
    if (st.isSymbolicLink()) {
      const linkDest = await readlink(targetDir).catch(() => null);
      if (
        linkDest &&
        (await realpath(targetDir).catch(() => null)) ===
          (await realpath(sourceDir).catch(() => null))
      ) {
        return;
      }
      await rm(targetDir, { force: true });
    } else if (st.isDirectory()) {
      const entries = await readdir(targetDir, { withFileTypes: true });
      for (const entry of entries) {
        const srcFile = path.join(targetDir, entry.name);
        const dstFile = path.join(sourceDir, entry.name);
        try {
          await lstat(dstFile);
        } catch {
          await cp(srcFile, dstFile, { recursive: true });
        }
      }
      await rm(targetDir, { recursive: true, force: true });
    } else {
      await rm(targetDir, { force: true });
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  try {
    await symlink(sourceDir, targetDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}

async function linkSharedSqliteDb(
  sourceDb: string,
  targetDb: string,
  tableName?: string,
): Promise<void> {
  let sourceExists = false;
  try {
    await stat(sourceDb);
    sourceExists = true;
  } catch {}

  try {
    const st = await lstat(targetDb);
    if (st.isSymbolicLink()) {
      if (
        (await realpath(targetDb).catch(() => null)) ===
        (await realpath(sourceDb).catch(() => null))
      ) {
        return;
      }
      await rm(targetDb, { force: true });
    } else if (st.isFile()) {
      if (!sourceExists) {
        await copyFile(targetDb, sourceDb);
        sourceExists = true;
      } else if (tableName) {
        try {
          const db = new Database(sourceDb, { timeout: 5000 });
          db.exec(`ATTACH DATABASE '${targetDb}' AS merge_source;`);
          db.exec(`INSERT OR IGNORE INTO ${tableName} SELECT * FROM merge_source.${tableName};`);
          db.exec('DETACH DATABASE merge_source;');
          db.close();
        } catch {}
      }
      await rm(targetDb, { force: true });
      await rm(`${targetDb}-wal`, { force: true }).catch(() => {});
      await rm(`${targetDb}-shm`, { force: true }).catch(() => {});
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  if (sourceExists) {
    try {
      await symlink(sourceDb, targetDb);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

async function linkSharedFile(sourceFile: string, targetFile: string): Promise<void> {
  let sourceExists = false;
  try {
    await stat(sourceFile);
    sourceExists = true;
  } catch {}

  try {
    const st = await lstat(targetFile);
    if (st.isSymbolicLink()) {
      if (
        (await realpath(targetFile).catch(() => null)) ===
        (await realpath(sourceFile).catch(() => null))
      ) {
        return;
      }
      await rm(targetFile, { force: true });
    } else if (st.isFile()) {
      if (!sourceExists) {
        await copyFile(targetFile, sourceFile);
        sourceExists = true;
      }
      await rm(targetFile, { force: true });
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  if (sourceExists) {
    try {
      await symlink(sourceFile, targetFile);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}
