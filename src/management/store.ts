import Database from 'better-sqlite3';
import { chmodSync, lstatSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import {
  Tool,
  type Binding,
  type Conversation,
  type Folder,
  type Invocation,
  type Profile,
  type Project,
  type ResourceObservation,
  type SessionEntry,
  type Snapshot,
} from './model.js';

type Kind =
  | 'folder'
  | 'profile'
  | 'project'
  | 'entry'
  | 'invocation'
  | 'conversation'
  | 'binding'
  | 'resource'
  | 'account'
  | 'auth-observation'
  | 'entitlement'
  | 'worker'
  | 'worker-request'
  | 'worker-lease'
  | 'swarm';
const stamp = () => new Date().toISOString();
export class ManagementStore {
  readonly db: Database.Database;
  private readonly statements = new Map<string, Database.Statement>();
  private prepare(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  constructor(file: string) {
    if (file !== ':memory:') {
      try {
        const s = lstatSync(file);
        if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid?.())
          throw new Error('Management database must be an owner-owned regular file');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    this.db = new Database(file);
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    const version = this.db.pragma('user_version', { simple: true });
    if (version !== 0 && version !== 1) {
      this.db.close();
      throw new Error('Unsupported management database version');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL, entityId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS resource_profile ON records(json_extract(data,'$.profileId')) WHERE kind='resource';
      CREATE INDEX IF NOT EXISTS resource_time ON records(julianday(json_extract(data,'$.observedAt'))) WHERE kind='resource';
      CREATE INDEX IF NOT EXISTS resource_windows ON records(json_extract(data,'$.profileId'),json_extract(data,'$.invocationId'),json_extract(data,'$.account'),json_extract(data,'$.metric'),json_extract(data,'$.bucket'),json_extract(data,'$.source'),json_extract(data,'$.observedAt') DESC) WHERE kind='resource';
      CREATE INDEX IF NOT EXISTS binding_invocation ON records(json_extract(data,'$.invocationId'),json_extract(data,'$.endedAt')) WHERE kind='binding';
      CREATE INDEX IF NOT EXISTS invocation_profile ON records(json_extract(data,'$.profileId'),json_extract(data,'$.lifecycle')) WHERE kind='invocation';
      CREATE INDEX IF NOT EXISTS invocation_entry ON records(json_extract(data,'$.entryId')) WHERE kind='invocation';
      PRAGMA user_version = 1;
    `);
    if (file !== ':memory:') chmodSync(file, 0o600);
    if (!this.get<Folder>('folder', 'unassigned'))
      this.put('folder', { id: 'unassigned', parentId: null, name: 'Unassigned', order: 0 });
  }
  close() {
    this.db.close();
  }
  get<T>(kind: Kind, id: string): T | null {
    const row = this.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : null;
  }
  require<T>(kind: Kind, id: string): T {
    const value = this.get<T>(kind, id);
    if (!value) throw new Error(`Unknown ${kind}`);
    return value;
  }
  list<T>(kind: Kind): T[] {
    return (
      this.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind) as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data));
  }
  put<T extends { id: string }>(kind: Kind, value: T) {
    this.prepare(
      'INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data',
    ).run(kind, value.id, JSON.stringify(value));
    return value;
  }
  deleteResourceByBucketPrefix(profileId: string, bucketPrefix: string, currentBucket: string) {
    this.prepare(
      `DELETE FROM records WHERE kind='resource' AND json_extract(data,'$.profileId')=? AND json_extract(data,'$.bucket') LIKE ? AND json_extract(data,'$.bucket') != ?`,
    ).run(profileId, `${bucketPrefix}%`, currentBucket);
  }
  event(type: string, entityId: string) {
    this.prepare('INSERT INTO events(at,type,entityId) VALUES(?,?,?)').run(stamp(), type, entityId);
  }
  get seq() {
    return (this.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get() as { seq: number })
      .seq;
  }
  events(after: number) {
    return this.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 1000').all(after);
  }
  folder(reference: string): Folder {
    const direct = this.get<Folder>('folder', reference);
    if (direct) return direct;
    let parentId: string | null = null;
    let found: Folder | undefined;
    for (const name of reference.split('/')) {
      found = this.list<Folder>('folder').find((f) => f.parentId === parentId && f.name === name);
      if (!found) throw new Error('Unknown folder');
      parentId = found.id;
    }
    if (!found) throw new Error('Unknown folder');
    return found;
  }
  createFolder(names: string[]) {
    return this.db.transaction(() => {
      let parentId: string | null = null;
      let folder: Folder | undefined;
      for (const name of names) {
        folder = this.list<Folder>('folder').find(
          (f) => f.parentId === parentId && f.name === name,
        );
        if (!folder) {
          folder = this.put('folder', {
            id: randomUUID(),
            parentId,
            name,
            order: this.list<Folder>('folder').length,
          });
          this.event('folder.created', folder.id);
        }
        parentId = folder.id;
      }
      return folder!;
    })();
  }
  updateFolder(id: string, changes: { name?: string; parentId?: string | null; order?: number }) {
    return this.db.transaction(() => {
      const folder = this.folder(id);
      if (folder.id === 'unassigned') throw new Error('Unassigned is a protected system folder');
      const updated = { ...folder, ...changes };
      if (
        this.list<Folder>('folder').some(
          (f) => f.id !== folder.id && f.parentId === updated.parentId && f.name === updated.name,
        )
      )
        throw new Error('A sibling folder already has that name');
      let parent = updated.parentId;
      const visited = new Set<string>();
      while (parent) {
        if (parent === folder.id || visited.has(parent))
          throw new Error('Folder move would create a cycle');
        visited.add(parent);
        parent = this.require<Folder>('folder', parent).parentId;
      }
      this.put('folder', updated);
      this.event('folder.updated', folder.id);
      return updated;
    })();
  }
  deleteFolder(id: string) {
    return this.db.transaction(() => {
      const folder = this.folder(id);
      if (folder.id === 'unassigned') throw new Error('Unassigned is a protected system folder');
      if (
        this.list<Folder>('folder').some((f) => f.parentId === folder.id) ||
        this.list<SessionEntry>('entry').some((e) => e.folderId === folder.id)
      )
        throw new Error('Move all contents before deleting a folder');
      this.prepare('DELETE FROM records WHERE kind=? AND id=?').run('folder', folder.id);
      this.event('folder.deleted', folder.id);
      return { deleted: folder.id };
    })();
  }
  profiles() {
    return this.list<Profile>('profile').filter(
      (p) => !p.removedAt && (Tool.options as readonly string[]).includes(p.tool),
    );
  }
  profile(reference: string) {
    const removed = this.get<Profile>('profile', reference);
    if (removed?.removedAt)
      throw new Error('This profile was removed. Add its existing configuration again to resume.');
    const profiles = this.profiles();
    const exact = profiles.find((p) => p.id === reference);
    if (exact) return exact;
    const matches = profiles.filter((p) => p.label === reference);
    if (matches.length !== 1)
      throw new Error(matches.length ? 'Ambiguous profile label; use its ID' : 'Unknown profile');
    return matches[0];
  }
  purgeProfile(profileId: string) {
    return this.db.transaction(() => {
      this.prepare("DELETE FROM records WHERE kind='profile' AND id=?").run(profileId);
      this.prepare(
        "DELETE FROM records WHERE kind='resource' AND json_extract(data,'$.profileId')=?",
      ).run(profileId);
      this.prepare(
        "DELETE FROM records WHERE kind='auth-observation' AND json_extract(data,'$.profileId')=?",
      ).run(profileId);
      this.prepare(
        `DELETE FROM records WHERE kind='binding' AND json_extract(data,'$.conversationId') IN (
          SELECT id FROM records WHERE kind='conversation' AND json_extract(data,'$.profileId')=?
        )`,
      ).run(profileId);
      this.prepare(
        "DELETE FROM records WHERE kind='conversation' AND json_extract(data,'$.profileId')=?",
      ).run(profileId);
      this.prepare(
        "UPDATE records SET data = json_set(data, '$.profileId', NULL) WHERE kind='invocation' AND json_extract(data,'$.profileId')=?",
      ).run(profileId);
      this.prepare(
        "UPDATE records SET data = json_set(data, '$.profileId', NULL) WHERE kind='entry' AND json_extract(data,'$.profileId')=?",
      ).run(profileId);
      this.prepare(
        "UPDATE records SET data = json_set(data, '$.conversationId', NULL) WHERE kind='entry' AND json_extract(data,'$.conversationId') NOT IN (SELECT id FROM records WHERE kind='conversation')",
      ).run();

      const row = this.prepare('SELECT value FROM settings WHERE key=?').get('active-profiles') as
        | { value: string }
        | undefined;
      if (row) {
        try {
          const active = JSON.parse(row.value) as Record<string, string>;
          let changed = false;
          for (const [tool, id] of Object.entries(active)) {
            if (id === profileId) {
              delete active[tool];
              changed = true;
            }
          }
          if (changed) {
            this.prepare(
              'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            ).run('active-profiles', JSON.stringify(active));
          }
        } catch {}
      }

      const uiRow = this.prepare('SELECT value FROM settings WHERE key=?').get('ui') as
        | { value: string }
        | undefined;
      if (uiRow) {
        try {
          const ui = JSON.parse(uiRow.value);
          if (ui.selected === profileId || ui.selected === `p:${profileId}`) {
            ui.selected = null;
            this.prepare(
              'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            ).run('ui', JSON.stringify(ui));
          }
        } catch {}
      }

      this.event('profile.purged', profileId);
      this.event('profile.removed', profileId);
      return { purged: profileId };
    })();
  }
  project(directory: string, environmentId: string) {
    const id = createHash('sha256')
      .update(`${environmentId}:${directory}`)
      .digest('hex')
      .slice(0, 24);
    return (
      this.get<Project>('project', id) ??
      this.put('project', {
        id,
        directory,
        environmentId,
        name: path.basename(directory) || directory,
      })
    );
  }
  updateEntry(
    id: string,
    changes: { title?: string; folderId?: string; archivedAt?: string | null },
  ) {
    const entry = this.require<SessionEntry>('entry', id);
    if (changes.folderId) this.require<Folder>('folder', changes.folderId);
    const updated = this.put('entry', { ...entry, ...changes });
    this.event('entry.updated', id);
    return updated;
  }
  updateInvocation(id: string, changes: Partial<Invocation>) {
    return this.put('invocation', {
      ...this.require<Invocation>('invocation', id),
      ...changes,
      id,
    });
  }
  bind(
    invocation: Invocation,
    nativeId: string,
    evidence: Binding['evidence'] = 'native-callback',
  ) {
    const entry = this.require<SessionEntry>('entry', invocation.entryId);
    const id = createHash('sha256')
      .update(`${entry.tool}:${invocation.profileId ?? 'external'}:${nativeId}`)
      .digest('hex')
      .slice(0, 32);
    this.put<Conversation>('conversation', {
      id,
      nativeId,
      tool: entry.tool,
      profileId: invocation.profileId,
      projectId: entry.projectId,
    });
    this.put('entry', { ...entry, conversationId: id });
    for (const binding of this.activeBindings(invocation.id)) {
      if (binding.conversationId === id) return;
      this.put('binding', { ...binding, endedAt: stamp() });
    }
    this.put('binding', {
      id: randomUUID(),
      invocationId: invocation.id,
      conversationId: id,
      startedAt: stamp(),
      endedAt: null,
      evidence,
    });
    this.event('conversation.bound', invocation.id);
  }
  finish(invocation: Invocation, exitCode: number | null) {
    this.db.transaction(() => {
      const endedAt = stamp();
      this.put('invocation', {
        ...invocation,
        lifecycle: 'exited' as const,
        activity: 'unknown' as const,
        connection: 'disconnected' as const,
        endedAt,
        exitCode,
        observedAt: endedAt,
      });
      for (const b of this.activeBindings(invocation.id)) this.put('binding', { ...b, endedAt });
      this.event('invocation.exited', invocation.id);
    })();
  }
  resources() {
    return (
      this.prepare(
        `SELECT data FROM (
      SELECT data, ROW_NUMBER() OVER (PARTITION BY json_extract(data,'$.profileId'), json_extract(data,'$.invocationId'),
      json_extract(data,'$.account'), json_extract(data,'$.metric'), json_extract(data,'$.bucket'), json_extract(data,'$.source') ORDER BY json_extract(data,'$.observedAt') DESC, rowid DESC) AS n
      FROM records WHERE kind='resource') WHERE n=1 ORDER BY json_extract(data,'$.observedAt') DESC LIMIT 1000`,
      ).all() as { data: string }[]
    ).map((r) => JSON.parse(r.data) as ResourceObservation);
  }
  private activeBindings(invocationId: string): (Binding & { id: string })[] {
    return (
      this.prepare(
        "SELECT data FROM records WHERE kind='binding' AND json_extract(data,'$.invocationId')=? AND json_extract(data,'$.endedAt') IS NULL",
      ).all(invocationId) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  prune(now = Date.now()) {
    const cutoff = new Date(now - 7 * 86400_000).toISOString();
    let resources = this.prepare(
      "DELETE FROM records WHERE kind='resource' AND julianday(json_extract(data,'$.observedAt')) < julianday(?)",
    ).run(cutoff).changes;
    resources += this.prepare(
      "DELETE FROM records WHERE kind='resource' AND json_extract(data,'$.invocationId') IS NOT NULL AND json_extract(data,'$.invocationId') NOT IN (SELECT id FROM records WHERE kind='invocation')",
    ).run().changes;
    resources += this.prepare(
      `DELETE FROM records WHERE kind='resource' AND rowid NOT IN (
        SELECT rowid FROM (
          SELECT rowid, ROW_NUMBER() OVER (
            PARTITION BY json_extract(data,'$.profileId'), json_extract(data,'$.invocationId'),
            json_extract(data,'$.account'), json_extract(data,'$.metric'), json_extract(data,'$.bucket'), json_extract(data,'$.source')
            ORDER BY json_extract(data,'$.observedAt') DESC, rowid DESC
          ) AS n FROM records WHERE kind='resource'
        ) WHERE n <= 3
      )`,
    ).run().changes;
    // Preserve every conversation, profile, owned invocation and binding. Only
    // empty, old external sightings are disposable; never delete native history.
    const sightingsCutoff = new Date(now - 3600_000).toISOString();
    const sightings = this.prepare(
      `WITH multi_entry AS (
        SELECT json_extract(data, '$.entryId') as entryId FROM records WHERE kind = 'invocation' GROUP BY entryId HAVING count(*) > 1
      ), bound_invocations AS (
        SELECT json_extract(data, '$.invocationId') as invocationId FROM records WHERE kind = 'binding'
      )
      SELECT i.id, json_extract(i.data,'$.entryId') AS entryId FROM records i JOIN records e ON e.kind='entry' AND e.id=json_extract(i.data,'$.entryId')
      WHERE i.kind='invocation' AND json_extract(i.data,'$.owned')=0 AND json_extract(i.data,'$.lifecycle')='exited'
      AND julianday(json_extract(i.data,'$.endedAt')) < julianday(?) AND json_extract(e.data,'$.conversationId') IS NULL
      AND i.id NOT IN (SELECT invocationId FROM bound_invocations)
      AND json_extract(i.data,'$.entryId') NOT IN (SELECT entryId FROM multi_entry)`,
    ).all(sightingsCutoff) as { id: string; entryId: string }[];
    const delInvocation = this.prepare('DELETE FROM records WHERE kind=? AND id=?');
    const delEntry = this.prepare('DELETE FROM records WHERE kind=? AND id=?');
    this.db.transaction(() => {
      for (const sighting of sightings) {
        delInvocation.run('invocation', sighting.id);
        delEntry.run('entry', sighting.entryId);
      }
    })();
    this.prepare(
      `DELETE FROM records WHERE kind='auth-observation' AND rowid NOT IN (
        SELECT rowid FROM (
          SELECT rowid, ROW_NUMBER() OVER (
            PARTITION BY json_extract(data,'$.profileId')
            ORDER BY json_extract(data,'$.observedAt') DESC, rowid DESC
          ) AS n FROM records WHERE kind='auth-observation'
        ) WHERE n <= 3
      )`,
    ).run();
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    return { resources, externalSightings: sightings.length };
  }
  dismissedAccountIds(): string[] {
    const row = this.prepare('SELECT value FROM settings WHERE key=?').get('dismissed-accounts') as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : [];
  }
  dismissAccounts(ids: string[]) {
    return this.db.transaction(() => {
      const dismissed = [...new Set([...this.dismissedAccountIds(), ...ids])];
      this.prepare(
        'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run('dismissed-accounts', JSON.stringify(dismissed));
      for (const id of ids) this.event('account.dismissed', id);
      return dismissed;
    })();
  }
  ui(): Snapshot['ui'] {
    const row = this.prepare('SELECT value FROM settings WHERE key=?').get('ui') as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : { expanded: ['f:unassigned'], selected: null };
  }
  saveUI(value: Snapshot['ui']) {
    this.prepare(
      'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run('ui', JSON.stringify(value));
  }
  activeProfiles(): Record<string, string> {
    const row = this.prepare('SELECT value FROM settings WHERE key=?').get('active-profiles') as
      { value: string } | undefined;
    const raw: Record<string, string> = row ? JSON.parse(row.value) : {};
    const valid: Record<string, string> = {};
    const current = this.profiles();
    for (const [tool, id] of Object.entries(raw)) {
      if (current.some((p) => p.tool === tool && p.id === id)) {
        valid[tool] = id;
      }
    }
    return valid;
  }
  setActiveProfile(tool: string, profileId: string) {
    const profile = this.profile(profileId);
    if (profile.tool !== tool)
      throw new Error(`Profile ${profile.label} does not belong to tool ${tool}`);
    return this.db.transaction(() => {
      const active = { ...this.activeProfiles(), [tool]: profile.id };
      this.prepare(
        'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run('active-profiles', JSON.stringify(active));
      this.event('profile.swapped', profile.id);
      return active;
    })();
  }
}
