import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { rpc } from '../dist/client.js';
import { ConfigSchema } from '../dist/schema.js';
const repo = await mkdtemp(path.join(tmpdir(), 'principal-session-live-'));
const marker = randomUUID();
await writeFile(path.join(repo, 'marker.txt'), marker);
const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
git(['init', '-q']);
git(['add', '.']);
git(['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'fixture']);
await writeFile(path.join(repo, 'user.txt'), 'existing user change\n');
await rpc('pools.create', {
  name: 'session-smoke',
  accounts: ['codex-free-1', 'codex-free-2', 'antigravity-1'],
});
const evidence = { repo, at: new Date().toISOString(), providers: [] };
async function settle(id) {
  const end = Date.now() + 360000;
  for (;;) {
    const s = await rpc('sessions.snapshot', { id });
    if (['idle', 'needs_review', 'stopped'].includes(s.session.status)) {
      if (s.session.status !== 'idle')
        throw new Error(JSON.stringify({ id, status: s.session.status, error: s.session.error }));
      return s;
    }
    if (Date.now() > end) {
      await rpc('sessions.interrupt', { id });
      throw new Error(`Session ${id} timed out`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
for (const lead of process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['codex-free-1', 'antigravity-1']) {
  const session = await rpc('sessions.create', {
    repo,
    pool: 'session-smoke',
    lead,
    config: ConfigSchema.parse({ attemptTimeoutSeconds: 240 }),
  });
  console.log(`${lead}: session ${session.id}`);
  const receipt = await rpc('sessions.submit', {
    id: session.id,
    clientMessageId: 'one',
    input:
      'Read marker.txt using a tool and reply with its exact contents. Remember it for the next turn. Do not delegate.',
  });
  const duplicate = await rpc('sessions.submit', {
    id: session.id,
    clientMessageId: 'one',
    input:
      'Read marker.txt using a tool and reply with its exact contents. Remember it for the next turn. Do not delegate.',
  });
  assert.equal(receipt.id, duplicate.id);
  let s = await settle(session.id);
  assert.ok(
    s.messages.some(
      (m) =>
        m.role === 'assistant' && m.parts.some((p) => p.type === 'text' && p.text.includes(marker)),
    ),
  );
  await rpc('sessions.submit', {
    id: session.id,
    clientMessageId: 'two',
    input: 'What marker did you read? Reply with it again without tools or delegation.',
  });
  s = await settle(session.id);
  const nativeId = s.session.nativeId;
  assert.ok(nativeId);
  if (lead.startsWith('codex')) await rpc('sessions.compact', { id: session.id });
  await rpc('sessions.configure', { id: session.id, lead });
  await rpc('sessions.submit', {
    id: session.id,
    clientMessageId: 'three',
    input: 'After continuation, what was the marker? Reply with it without tools or delegation.',
  });
  s = await settle(session.id);
  assert.equal(
    s.session.nativeId,
    nativeId,
    'cold resume should retain the native conversation ID',
  );
  if (lead.startsWith('antigravity')) {
    await rpc('sessions.compact', { id: session.id });
    await rpc('sessions.submit', {
      id: session.id,
      clientMessageId: 'four',
      input:
        'Continue from the portable checkpoint. Return the remembered marker without tools or delegation.',
    });
    s = await settle(session.id);
  }
  const replies = s.messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text));
  assert.ok(replies.at(-1).includes(marker));
  evidence.providers.push({
    lead,
    id: session.id,
    nativeId,
    continuedNativeId: s.session.nativeId,
    turns: s.turns.length,
    checkpoint: s.session.checkpointId,
  });
  await rpc('sessions.interrupt', { id: session.id });
  console.log(
    `PASS ${lead}: duplicate admission, repeated turns, compaction and cold continuation`,
  );
}
const file = path.join(repo, 'evidence.json');
await writeFile(file, JSON.stringify(evidence, null, 2));
console.log(`Evidence ${file}`);
