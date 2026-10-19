import Database from 'better-sqlite3';
import { chmodSync, existsSync, copyFileSync } from 'node:fs';
import type { Session, Turn, Message, Checkpoint } from './session-types.js';
import { paths, now, redact } from './util.js';
import type { Account, QuotaSnapshot, Run, TaskRecord, Attempt, Event } from './schema.js';
export class Store {
  db: Database.Database;
  constructor() {
    this.db = new Database(paths.db);
    chmodSync(paths.db, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,label TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pools(name TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quotas(account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,id TEXT,data TEXT NOT NULL,PRIMARY KEY(run_id,id));
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,account_id TEXT REFERENCES accounts(id),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,task_id TEXT,attempt_id TEXT,type TEXT,at TEXT,data TEXT);
      CREATE INDEX IF NOT EXISTS events_run_sequence ON events(run_id,seq);
      CREATE INDEX IF NOT EXISTS events_attempt_type ON events(attempt_id,type,seq);
      CREATE TABLE IF NOT EXISTS leases(account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,owner TEXT NOT NULL,container TEXT);`);
    const version = this.db.prepare('SELECT value FROM meta WHERE key=?').get('schema') as
      | { value: string }
      | undefined;
    if (version && !['1', '2'].includes(version.value))
      throw new Error('Unsupported database schema');
    if (version?.value === '1') {
      // Checkpoint WAL before backing up under the daemon's lifetime lock.
      this.db.pragma('wal_checkpoint(FULL)');
      if (!existsSync(`${paths.db}.pre-sessions`)) {
        copyFileSync(paths.db, `${paths.db}.pre-sessions`);
        chmodSync(`${paths.db}.pre-sessions`, 0o600);
      }
    }
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,parent_id TEXT REFERENCES sessions(id),data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS turns(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,session_id TEXT REFERENCES sessions(id),client_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(session_id,client_id));
        CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,session_id TEXT REFERENCES sessions(id),data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS session_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT REFERENCES sessions(id),type TEXT NOT NULL,at TEXT NOT NULL,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id),data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS context_sources(session_id TEXT REFERENCES sessions(id),source TEXT,hash TEXT,content TEXT,PRIMARY KEY(session_id,source));
        CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id),hash TEXT NOT NULL,file TEXT NOT NULL,bytes INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id,seq);
        CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,seq);
        CREATE INDEX IF NOT EXISTS session_events_cursor ON session_events(session_id,seq);
      `);
      this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('schema', '2');
    })();
  }
  private rows<T>(table: string, where = '', args: unknown[] = []): T[] {
    return (
      this.db.prepare(`SELECT data FROM ${table} ${where}`).all(...args) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  accounts() {
    return this.rows<Account>('accounts');
  }
  account(idOrLabel: string) {
    const a = this.accounts().find((a) => a.id === idOrLabel || a.label === idOrLabel);
    if (!a) throw new Error(`Unknown account ${idOrLabel}`);
    return a;
  }
  saveAccount(a: Account) {
    this.db
      .prepare(
        'INSERT INTO accounts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,data=excluded.data',
      )
      .run(a.id, a.label, JSON.stringify(a));
  }
  pool(name: string) {
    const row = this.db.prepare('SELECT data FROM pools WHERE name=?').get(name) as
      | { data: string }
      | undefined;
    if (!row) throw new Error(`Unknown pool ${name}`);
    return JSON.parse(row.data) as string[];
  }
  pools() {
    return (
      this.db.prepare('SELECT name,data FROM pools').all() as { name: string; data: string }[]
    ).map((x) => ({ name: x.name, accounts: JSON.parse(x.data) }));
  }
  savePool(name: string, ids: string[]) {
    this.db.prepare('INSERT OR REPLACE INTO pools VALUES(?,?)').run(name, JSON.stringify(ids));
  }
  quota(id: string) {
    return this.rows<QuotaSnapshot>('quotas', 'WHERE account_id=?', [id])[0] ?? null;
  }
  saveQuota(q: QuotaSnapshot) {
    this.db
      .prepare('INSERT OR REPLACE INTO quotas VALUES(?,?)')
      .run(q.accountId, JSON.stringify(q));
  }
  runs() {
    return this.rows<Run>('runs');
  }
  run(id: string) {
    const row = this.rows<Run>('runs', 'WHERE id=?', [id])[0];
    if (!row) throw new Error(`Unknown run ${id}`);
    return row;
  }
  saveRun(r: Run) {
    this.db
      .prepare('INSERT INTO runs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(r.id, JSON.stringify(r));
  }
  tasks(runId: string) {
    return this.rows<TaskRecord>('tasks', 'WHERE run_id=?', [runId]);
  }
  saveTask(t: TaskRecord) {
    this.db
      .prepare(
        'INSERT INTO tasks VALUES(?,?,?) ON CONFLICT(run_id,id) DO UPDATE SET data=excluded.data',
      )
      .run(t.runId, t.id, JSON.stringify(t));
  }
  attempts(runId?: string) {
    return this.rows<Attempt>('attempts', runId ? 'WHERE run_id=?' : '', runId ? [runId] : []);
  }
  saveAttempt(a: Attempt) {
    this.db
      .prepare(
        'INSERT INTO attempts VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(a.id, a.runId, a.accountId, JSON.stringify(a));
  }
  event(
    runId: string,
    type: string,
    data: unknown,
    taskId: string | null = null,
    attemptId: string | null = null,
  ) {
    this.db
      .prepare('INSERT INTO events(run_id,task_id,attempt_id,type,at,data) VALUES(?,?,?,?,?,?)')
      .run(runId, taskId, attemptId, type, now(), redact(JSON.stringify(data)));
  }
  events(runId: string, after = 0) {
    return (
      this.db
        .prepare('SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 1000')
        .all(runId, after) as any[]
    ).map((x) => ({
      seq: x.seq,
      runId: x.run_id,
      taskId: x.task_id,
      attemptId: x.attempt_id,
      type: x.type,
      at: x.at,
      data: (() => {
        try {
          return JSON.parse(x.data);
        } catch {
          return { error: 'Stored event is malformed; payload withheld' };
        }
      })(),
    })) as Event[];
  }
  lease(accountId: string, owner: string, container: string | null = null) {
    try {
      this.db.prepare('INSERT INTO leases VALUES(?,?,?)').run(accountId, owner, container);
      return true;
    } catch (e) {
      if ((e as any).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return false;
      throw e;
    }
  }
  setContainer(accountId: string, container: string) {
    this.db.prepare('UPDATE leases SET container=? WHERE account_id=?').run(container, accountId);
  }
  release(accountId: string, owner: string) {
    this.db.prepare('DELETE FROM leases WHERE account_id=? AND owner=?').run(accountId, owner);
  }
  leases() {
    return this.db.prepare('SELECT account_id AS accountId,owner,container FROM leases').all() as {
      accountId: string;
      owner: string;
      container: string | null;
    }[];
  }
  transaction(fn: () => void) {
    this.db.transaction(fn)();
  }
  sessions() {
    return this.rows<Session>('sessions');
  }
  session(id: string) {
    const s = this.rows<Session>('sessions', 'WHERE id=?', [id])[0];
    if (!s) throw new Error(`Unknown session ${id}`);
    return s;
  }
  saveSession(s: Session) {
    this.db
      .prepare(
        'INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(s.id, s.parentId, JSON.stringify(s));
  }
  turns(id: string) {
    return this.rows<Turn>('turns', 'WHERE session_id=? ORDER BY seq', [id]);
  }
  saveTurn(t: Turn) {
    this.db
      .prepare(
        'INSERT INTO turns(id,session_id,client_id,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(t.id, t.sessionId, t.clientMessageId, JSON.stringify(t));
  }
  messages(id: string, after = 0, limit = 100) {
    return this.db
      .prepare('SELECT seq,data FROM messages WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(id, after, limit)
      .map((r: any) => ({ seq: r.seq, ...JSON.parse(r.data) })) as (Message & { seq: number })[];
  }
  message(m: Message) {
    this.db
      .prepare('INSERT INTO messages(id,session_id,data) VALUES(?,?,?)')
      .run(m.id, m.sessionId, JSON.stringify(m));
  }
  sessionEvent(id: string, type: string, data: unknown) {
    this.db
      .prepare('INSERT INTO session_events(session_id,type,at,data) VALUES(?,?,?,?)')
      .run(id, type, now(), redact(JSON.stringify(data)));
  }
  sessionEvents(id: string, after = 0) {
    return this.db
      .prepare(
        'SELECT seq,type,at,data FROM session_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT 1000',
      )
      .all(id, after)
      .map((r: any) => ({ ...r, data: JSON.parse(r.data) }));
  }
  saveCheckpoint(c: Checkpoint) {
    this.db
      .prepare('INSERT INTO checkpoints VALUES(?,?,?)')
      .run(c.id, c.sessionId, JSON.stringify(c));
  }
  checkpoint(id: string | null) {
    return id ? (this.rows<Checkpoint>('checkpoints', 'WHERE id=?', [id])[0] ?? null) : null;
  }
  close() {
    this.db.close();
  }
}
