import Database from 'better-sqlite3';
import { constants } from 'node:fs';
import { lstat, stat, realpath, open, mkdtemp, chmod, link, rm } from 'node:fs/promises';
import path from 'node:path';
import { managementPaths, privateDirectory } from './paths.js';
import { Label, type Profile, type Installation } from './model.js';
import { isAllowedHistoryPath } from './shared-history.js';

const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const maximumBytes = 256 * 1024 * 1024;
const tables = [
  'trajectory_meta',
  'steps',
  'gen_metadata',
  'executor_metadata',
  'parent_references',
  'trajectory_metadata_blob',
  'battle_mode_infos',
];
const summaryColumns = {
  conversation_id: 'TEXT PRIMARY KEY',
  title: 'TEXT',
  preview: 'TEXT',
  step_count: 'INTEGER',
  last_modified_time: 'datetime',
  workspace_uris: 'TEXT',
  status: 'TEXT',
  source: 'TEXT',
  project_id: 'TEXT',
  agent_name: 'TEXT',
  parent_conversation_id: 'TEXT',
  nesting_depth: 'INTEGER',
  battle_id: 'TEXT',
  winning_conversation_id: 'TEXT',
  not_fully_idle: 'numeric',
  killed: 'numeric',
  last_user_input_time: 'datetime',
  last_user_input_step_index: 'INTEGER',
  app_data_dir: 'TEXT',
  raw_summary: 'BLOB',
  group_id: 'TEXT',
};
function summarySchema(db: Database.Database) {
  const columns = db.prepare('PRAGMA table_info(conversation_summaries)').all() as {
    name: string;
    type: string;
    pk: number;
  }[];
  if (
    JSON.stringify(columns.map((r) => r.name)) !== JSON.stringify(Object.keys(summaryColumns)) ||
    columns.some(
      (column) =>
        column.type.toUpperCase() !==
          summaryColumns[column.name as keyof typeof summaryColumns]
            .replace(' PRIMARY KEY', '')
            .toUpperCase() || column.pk !== (column.name === 'conversation_id' ? 1 : 0),
    )
  )
    throw new Error('Unsupported Antigravity summary schema');
}
async function copySummary(source: string, target: string, nativeId: string) {
  const src = path.join(source, 'conversation_summaries.db');
  await safeSqlite(src);
  const input = readonly(src);
  let row: Record<string, unknown>;
  try {
    summarySchema(input);
    row = input
      .prepare('SELECT * FROM conversation_summaries WHERE conversation_id=?')
      .get(nativeId) as Record<string, unknown>;
  } finally {
    input.close();
  }
  if (
    !row ||
    row.not_fully_idle ||
    row.battle_id ||
    row.winning_conversation_id ||
    row.app_data_dir !== 'antigravity-cli'
  )
    throw new Error('Source summary changed or has unsupported storage ownership');
  if (
    row.parent_conversation_id &&
    !(await localConversationAvailable(target, String(row.parent_conversation_id)))
  )
    throw new Error(
      'Parent conversation is unavailable in the destination; copy its history first',
    );
  const file = path.join(target, 'conversation_summaries.db');
  for (const suffix of ['', '-wal', '-shm'])
    try {
      await safeFile(file + suffix);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  const exists = await lstat(file).then(
    () => true,
    (e) => {
      if (e.code === 'ENOENT') return false;
      throw e;
    },
  );
  const db = new Database(file, { timeout: 2000 });
  try {
    if (!exists)
      db.exec(
        'CREATE TABLE conversation_summaries (' +
          Object.entries(summaryColumns)
            .map(([name, type]) => name + ' ' + type)
            .join(',') +
          ')',
      );
    summarySchema(db);
    const names = Object.keys(summaryColumns);
    db.prepare(
      'INSERT INTO conversation_summaries (' +
        names.join(',') +
        ') VALUES (' +
        names.map(() => '?').join(',') +
        ')',
    ).run(...names.map((n) => row[n]));
  } catch (e) {
    db.close();
    if (!exists) await rm(file, { force: true });
    throw e;
  }
  db.close();
  await chmod(file, 0o600);
}
export function requireAntigravityHistory(installation: Installation) {
  if (installation.tool !== 'antigravity' || !installation.executable)
    throw new Error(
      'Install Antigravity before using experimental history copying; source and destination schemas must match the supported contract',
    );
}
async function safeFile(file: string) {
  const linkStat = await lstat(file);
  let resolved: string | null = null;
  try {
    resolved = await realpath(file);
  } catch {}
  if (!resolved || (linkStat.isSymbolicLink() && !isAllowedHistoryPath(resolved))) {
    throw new Error(
      'History file must be regular, owned and canonical without symlinks, and at most 256 MiB',
    );
  }
  const s = await stat(resolved);
  if (
    !s.isFile() ||
    s.uid !== process.getuid?.() ||
    s.size > maximumBytes
  )
    throw new Error(
      'History file must be regular, owned and canonical without symlinks, and at most 256 MiB',
    );
  return s;
}
async function safeSqlite(file: string) {
  await safeFile(file);
  for (const suffix of ['-wal', '-shm'])
    try {
      await safeFile(file + suffix);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
}
async function fingerprint(file: string) {
  return Promise.all(
    ['', '-wal'].map(async (suffix) => {
      try {
        const s = await safeFile(file + suffix);
        return [s.ino, s.size, s.mtimeMs, s.ctimeMs];
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    }),
  ).then(JSON.stringify);
}
async function safeRoot(directory: string) {
  const linkStat = await lstat(directory);
  let resolved: string | null = null;
  try {
    resolved = await realpath(directory);
  } catch {}
  if (!resolved || (linkStat.isSymbolicLink() && !isAllowedHistoryPath(resolved))) {
    throw new Error('History directory must be canonical, owned by this user and not a symlink');
  }
  const s = await stat(resolved);
  if (
    !s.isDirectory() ||
    s.uid !== process.getuid?.()
  )
    throw new Error('History directory must be canonical, owned by this user and not a symlink');
}
function readonly(file: string) {
  return new Database(file, { readonly: true, fileMustExist: true, timeout: 2000 });
}
function schema(db: Database.Database) {
  const names = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  )
    .map((r) => r.name)
    .sort();
  if (JSON.stringify(names) !== JSON.stringify([...tables].sort()))
    throw new Error('Unsupported Antigravity SQLite history schema');
  for (const [table, columns] of [
    ['trajectory_meta', ['trajectory_id', 'cascade_id']],
    ['steps', ['idx', 'status', 'has_subtrajectory', 'step_payload']],
    ['trajectory_metadata_blob', ['id', 'data']],
  ] as const) {
    const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name,
    );
    if (columns.some((c) => !actual.includes(c)))
      throw new Error('Unsupported Antigravity SQLite columns');
  }
  if (db.pragma('quick_check', { simple: true }) !== 'ok')
    throw new Error('Conversation database is corrupt');
}
export async function antigravityHistory(profile: Profile, installation: Installation) {
  requireAntigravityHistory(installation);
  await safeRoot(profile.directory);
  const summary = path.join(profile.directory, 'conversation_summaries.db');
  try {
    await safeSqlite(summary);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const db = readonly(summary);
  try {
    summarySchema(db);
    const rows = db
      .prepare(
        'SELECT conversation_id, title, workspace_uris, not_fully_idle, parent_conversation_id FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 1000',
      )
      .all() as {
      conversation_id: string;
      title: string;
      workspace_uris: string;
      not_fully_idle: number;
      parent_conversation_id: string | null;
    }[];
    return rows.flatMap((row) => {
      if (!idPattern.test(row.conversation_id)) return [];
      let workspaces: unknown;
      try {
        workspaces = JSON.parse(row.workspace_uris);
      } catch {
        return [];
      }
      if (
        !Array.isArray(workspaces) ||
        workspaces.length !== 1 ||
        typeof workspaces[0] !== 'string'
      )
        return [];
      let directory: string;
      try {
        directory =
          new URL(workspaces[0]).protocol === 'file:'
            ? decodeURIComponent(new URL(workspaces[0]).pathname)
            : '';
      } catch {
        return [];
      }
      if (!path.isAbsolute(directory)) return [];
      const title = Label.safeParse(row.title);
      return [
        {
          nativeId: row.conversation_id,
          title: title.success ? title.data : `antigravity · ${row.conversation_id.slice(0, 8)}`,
          directory,
          active: !!row.not_fully_idle,
          parentNativeId: row.parent_conversation_id || null,
        },
      ];
    });
  } finally {
    db.close();
  }
}

/** Experimental local snapshot: opaque records and native IDs are preserved, not rewritten. */
async function copySingleAntigravityConversation(
  source: Profile,
  target: Profile,
  installation: Installation,
  nativeId: string,
) {
  requireAntigravityHistory(installation);
  if (
    source.tool !== 'antigravity' ||
    target.tool !== 'antigravity' ||
    !target.isolated ||
    source.directory === target.directory
  )
    throw new Error('Choose a different isolated Antigravity destination profile');
  if (!idPattern.test(nativeId)) throw new Error('Invalid Antigravity conversation ID');
  await safeRoot(source.directory);
  await safeRoot(target.directory);
  const conversation = (await antigravityHistory(source, installation)).find(
    (c) => c.nativeId === nativeId,
  );
  if (!conversation || conversation.active)
    throw new Error('Source history is unavailable, has multiple workspaces, or is still active');
  const srcDir = path.join(source.directory, 'conversations');
  await safeRoot(srcDir);
  const src = path.join(srcDir, `${nativeId}.db`);
  try {
    await safeSqlite(src);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(
        'Conversation exists in the native index but its local database is missing; import or recover it in the native tool first',
      );
    throw e;
  }
  const summary = path.join(source.directory, 'conversation_summaries.db');
  // Check WAL and SHM paths before SQLite opens them. The online backup includes committed WAL pages.
  for (const suffix of ['-wal', '-shm'])
    try {
      await safeFile(src + suffix);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  const destDir = path.join(target.directory, 'conversations');
  await privateDirectory(destDir);
  await safeRoot(destDir);
  const dest = path.join(destDir, `${nativeId}.db`);
  for (const suffix of ['', '-wal', '-shm']) {
    if (
      await lstat(dest + suffix).then(
        () => true,
        (e) => {
          if (e.code === 'ENOENT') return false;
          throw e;
        },
      )
    )
      throw new Error(
        'Destination already has this native ID; existing history will not be overwritten or synchronized',
      );
  }
  const stage = await mkdtemp(path.join(managementPaths.state, 'agy-history-copy-'));
  let published = false;
  const copy = path.join(stage, 'conversation.db');
  let db: Database.Database | undefined;
  try {
    db = readonly(src);
    schema(db);
    const meta = db.prepare('SELECT cascade_id FROM trajectory_meta').all() as {
      cascade_id: string;
    }[];
    if (meta.length !== 1 || meta[0]!.cascade_id !== nativeId)
      throw new Error('Conversation identity does not match its local database');
    if (
      (db.prepare('SELECT COUNT(*) AS n FROM parent_references').get() as { n: number }).n ||
      (
        db.prepare('SELECT COUNT(*) AS n FROM steps WHERE has_subtrajectory != 0').get() as {
          n: number;
        }
      ).n ||
      (db.prepare('SELECT COUNT(*) AS n FROM battle_mode_infos').get() as { n: number }).n
    )
      throw new Error(
        'This conversation has dependent trajectories or battle state; exact copying is not supported',
      );
    const before = await Promise.all([fingerprint(src), fingerprint(summary)]);
    await db.backup(copy);
    await chmod(copy, 0o600);
    if ((await safeFile(copy)).size > maximumBytes) throw new Error('Conversation exceeds 256 MiB');
    const copied = readonly(copy);
    try {
      schema(copied);
    } finally {
      copied.close();
    }
    // No hard link to source storage: only the newly created snapshot is published.
    await link(copy, dest);
    published = true;
    const h = await open(dest, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await h.sync();
    } finally {
      await h.close();
    }
    const after = await Promise.all([fingerprint(src), fingerprint(summary)]);
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error('Source history changed during snapshot; close native sessions and retry');
    await copySummary(source.directory, target.directory, nativeId);
    return { ...conversation, nativeId, experimental: true, nativeResumeVerified: false };
  } catch (e) {
    if (published) await rm(dest, { force: true });
    throw e;
  } finally {
    db?.close();
    await rm(stage, { recursive: true, force: true });
  }
}

/** A registry row alone is not proof that usable local history exists. */
export async function localConversationAvailable(directory: string, nativeId: string) {
  if (!idPattern.test(nativeId)) return false;
  const summary = path.join(directory, 'conversation_summaries.db');
  const file = path.join(directory, 'conversations', nativeId + '.db');
  try {
    await safeRoot(directory);
    await safeSqlite(summary);
    await safeSqlite(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
  const index = readonly(summary),
    db = readonly(file);
  try {
    summarySchema(index);
    schema(db);
    const meta = db.prepare('SELECT cascade_id FROM trajectory_meta').all() as {
      cascade_id: string;
    }[];
    return (
      !!index
        .prepare('SELECT 1 FROM conversation_summaries WHERE conversation_id=?')
        .get(nativeId) &&
      meta.length === 1 &&
      meta[0]!.cascade_id === nativeId
    );
  } finally {
    index.close();
    db.close();
  }
}
/** Copy parent dependencies first without changing their native identities. */
export async function copyAntigravityConversation(
  source: Profile,
  target: Profile,
  installation: Installation,
  nativeId: string,
) {
  requireAntigravityHistory(installation);
  if (
    source.tool !== 'antigravity' ||
    target.tool !== 'antigravity' ||
    !target.isolated ||
    source.directory === target.directory
  )
    throw new Error('Choose a different isolated Antigravity destination profile');
  const threads = await antigravityHistory(source, installation);
  const chain: string[] = [];
  const visited = new Set<string>();
  let cursor: string | null = nativeId;
  while (cursor) {
    if (visited.has(cursor)) throw new Error('Cyclic parent conversation history is unsupported');
    visited.add(cursor);
    const thread = threads.find((t) => t.nativeId === cursor);
    if (!thread)
      throw new Error('Source parent conversation is missing from indexed local history');
    chain.push(cursor);
    cursor = thread.parentNativeId;
  }
  const dependencies: Awaited<ReturnType<typeof copySingleAntigravityConversation>>[] = [];
  for (const id of chain.reverse()) {
    if (id !== nativeId && (await localConversationAvailable(target.directory, id))) continue;
    const copy = await copySingleAntigravityConversation(source, target, installation, id);
    if (id === nativeId) return { ...copy, dependencies };
    dependencies.push(copy);
  }
  throw new Error('Invalid Antigravity conversation ID');
}
