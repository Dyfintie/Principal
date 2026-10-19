import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rpc } from '../dist/client.js';
import { ConfigSchema } from '../dist/schema.js';
const directory = await mkdtemp(path.join(tmpdir(), 'principal-antigravity-chat-'));
const session = await rpc('sessions.create', {
  repo: directory,
  pool: 'session-smoke',
  lead: 'antigravity-1',
  config: ConfigSchema.parse({ attemptTimeoutSeconds: 180 }),
});
console.log(`Greeting test session ${session.id}`);
await rpc('sessions.submit', { id: session.id, clientMessageId: 'greeting', input: 'Hello! Please greet me briefly.' });
const started = Date.now();
let snapshot;
while (Date.now() - started < 240000) {
  snapshot = await rpc('sessions.snapshot', { id: session.id });
  if (['idle', 'needs_review', 'stopped'].includes(snapshot.session.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
try {
  assert.equal(snapshot.session.status, 'idle', snapshot.session.error ?? 'Greeting did not settle');
  const reply = snapshot.messages.filter((message) => message.role === 'assistant').flatMap((message) => message.parts.filter((part) => part.type === 'text').map((part) => part.text)).join('\n');
  assert.match(reply, /hello|hi\b|greet|hey/i);
  assert.ok(!snapshot.events.some((event) => event.type === 'provider.tool'), 'Greeting should not explore files');
  const turn = snapshot.turns[0];
  const completed = snapshot.messages.find((message) => message.role === 'assistant');
  const evidence = { at: new Date().toISOString(), sessionId: session.id, directory, directoryMode: snapshot.session.directoryMode, nativeId: snapshot.session.nativeId, reply, elapsedSeconds: Math.round((Date.now() - started) / 1000), dispatchAt: turn.dispatchAt, completedAt: completed?.at, tools: 0 };
  await writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  console.log('PASS: live Antigravity responds to a greeting from an ordinary directory without tools');
} finally {
  await rpc('sessions.interrupt', { id: session.id });
}
