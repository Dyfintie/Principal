import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Session, Checkpoint } from './session-types.js';
import { Store } from './store.js';
import { atomicWrite, uid, now, paths } from './util.js';
export const leadResult = z
  .object({
    reply: z.string().max(100000),
    summary: z.string().max(16000),
    action: z.enum(['respond', 'ask_question', 'delegate', 'await_workers', 'retrieve_context']),
    question: z.string().max(8000).nullable(),
    retrieval: z
      .object({
        artifactId: z.string().nullable(),
        start: z.number().int().min(1),
        count: z.number().int().min(1).max(200),
        query: z.string().max(200).nullable(),
      })
      .nullable()
      .optional()
      .default(null),
    tasks: z
      .array(
        z.object({
          id: z.string(),
          instruction: z.string().max(100000),
          mode: z.enum(['read', 'write']),
          writePaths: z.array(z.string()),
          dependsOn: z.array(z.string()),
          provider: z.enum(['codex', 'antigravity']).nullable(),
          account: z.string().nullable(),
          model: z.string().nullable(),
        }),
      )
      .max(20),
  })
  .strict();
export function bounded(text: string, maxBytes = 8192, maxLines = 200) {
  const lines = text.split('\n').slice(0, maxLines).join('\n');
  let bytes = 0,
    output = '';
  for (const c of lines) {
    const n = Buffer.byteLength(c);
    if (bytes + n > maxBytes) break;
    bytes += n;
    output += c;
  }
  return output;
}
// UTF-8 bytes / 3 is a conservative estimate, not reported native occupancy.
export const estimateTokens = (text: string) => Math.ceil(Buffer.byteLength(text) / 3);
export async function reconcileInstructions(store: Store, s: Session, initial = false) {
  for (const source of ['AGENTS.md', 'principal.config.json']) {
    let content: string;
    try {
      content = await readFile(path.join(s.repo, source), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        store.sessionEvent(s.id, 'instruction_unavailable', { source });
        continue;
      }
      content = '';
    }
    const hash = createHash('sha256').update(content).digest('hex');
    const previous = store.db
      .prepare('SELECT hash FROM context_sources WHERE session_id=? AND source=?')
      .get(s.id, source) as { hash: string } | undefined;
    if (previous?.hash === hash) continue;
    store.transaction(() => {
      store.db
        .prepare('INSERT OR REPLACE INTO context_sources VALUES(?,?,?,?)')
        .run(s.id, source, hash, bounded(content, 12000));
      store.sessionEvent(
        s.id,
        initial ? 'instruction_admitted' : content ? 'instruction_changed' : 'instruction_removed',
        { source, hash },
      );
    });
  }
}
export function constraints(store: Store, s: Session) {
  const sources = (
    store.db
      .prepare('SELECT source,hash,content FROM context_sources WHERE session_id=?')
      .all(s.id) as { source: string; hash: string; content: string }[]
  ).map((x) => ({ ...x, content: bounded(x.content, 4000) }));
  const questions = (
    store.db
      .prepare(
        "SELECT data FROM messages WHERE session_id=? AND data LIKE '%question%' ORDER BY seq DESC",
      )
      .all(s.id) as { data: string }[]
  ).flatMap((row) =>
    (JSON.parse(row.data) as import('./session-types.js').Message).parts.filter(
      (p) => p.type === 'question' && !p.answered,
    ),
  );
  const admissions = store
    .turns(s.id)
    .filter(
      (t) => !t.clientMessageId.startsWith('workers:') && !t.clientMessageId.startsWith('context:'),
    );
  const objective = admissions[0]
    ? { turnId: admissions[0].id, text: bounded(admissions[0].input, 4000) }
    : null;
  const latestUserUpdates = admissions
    .slice(-4)
    .map((t) => ({ turnId: t.id, text: bounded(t.input, 1000) }));
  return JSON.stringify({
    objective,
    latestUserUpdates,
    pendingQuestions: questions,
    activeRunId: s.activeRunId,
    checkpointId: s.checkpointId,
    pool: s.pool,
    accounts: s.accountIds,
    permissions: s.config.permissions,
    recursiveDelegation: false,
    maxTasks: s.config.supervisor.maxTasks,
    workspaceVersion: s.workspaceVersion,
    sources,
  });
}
export function continuation(store: Store, s: Session, summary?: string): Checkpoint {
  const prior = store.checkpoint(s.checkpointId);
  const rows = store.db
    .prepare('SELECT data FROM messages WHERE session_id=? ORDER BY seq DESC LIMIT 24')
    .all(s.id) as { data: string }[];
  const telemetry = store.db
    .prepare(
      "SELECT data FROM session_events WHERE session_id=? AND type='provider.usage' ORDER BY seq DESC LIMIT 1",
    )
    .get(s.id) as { data: string } | undefined;
  const window = telemetry ? JSON.parse(telemetry.data)?.tokenUsage?.modelContextWindow : null;
  const target =
    typeof window === 'number' && window > 0 ? Math.min(16000, Math.floor(window * 0.7)) : 16000;
  const state = bounded(summary ?? prior?.summary ?? '', Math.floor(target * 0.25) * 3, 1000);
  const policy = constraints(store, s);
  if (estimateTokens(policy) > target * 0.4)
    throw new Error('Admitted instructions exceed the supplied context budget');
  const recentBudget = Math.max(0, Math.floor(target * 3) - Buffer.byteLength(policy + state));
  let recent = '';
  for (const row of rows) {
    const entry = bounded(row.data, Math.min(8192, recentBudget), 1000);
    if (Buffer.byteLength(entry + '\n' + recent) > recentBudget) break;
    recent = entry + '\n' + recent;
  }
  const c = {
    id: uid(),
    sessionId: s.id,
    at: now(),
    workspaceVersion: s.workspaceVersion,
    summary: state,
    recent,
    constraints: policy,
    estimatedTokens: estimateTokens(state + recent + policy),
  };
  return c;
}
export function commitCheckpoint(store: Store, s: Session, summary?: string) {
  const c = continuation(store, s, summary);
  store.transaction(() => {
    store.saveCheckpoint(c);
    s.checkpointId = c.id;
    store.saveSession(s);
    store.sessionEvent(s.id, 'checkpoint_completed', {
      id: c.id,
      estimatedTokens: c.estimatedTokens,
      source: 'estimated',
    });
  });
  return c;
}
export async function artifact(store: Store, s: Session, text: string) {
  const id = uid(),
    dir = path.join(paths.state, 'sessions', s.id, 'artifacts');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, id),
    hash = createHash('sha256').update(text).digest('hex');
  await atomicWrite(file, text);
  store.db
    .prepare('INSERT INTO artifacts VALUES(?,?,?,?,?)')
    .run(id, s.id, hash, file, Buffer.byteLength(text));
  return { id, preview: bounded(text), hash, bytes: Buffer.byteLength(text) };
}
