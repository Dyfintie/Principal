import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { rpc } from '../dist/client.js';
import { ConfigSchema } from '../dist/schema.js';
const repo = await mkdtemp(path.join(tmpdir(), 'principal-interactive-workflow-'));
const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
await writeFile(path.join(repo, 'user.txt'), 'committed\n');
git(['init', '-q']);
git(['add', '.']);
git(['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'baseline']);
await writeFile(path.join(repo, 'user.txt'), 'staged\n');
git(['add', 'user.txt']);
await writeFile(path.join(repo, 'user.txt'), 'unstaged user work\n');
await writeFile(path.join(repo, 'untracked.txt'), 'keep\n');
const head = git(['rev-parse', 'HEAD']),
  index = await readFile(path.join(repo, '.git', 'index'));
const config = ConfigSchema.parse({
  attemptTimeoutSeconds: 180,
  validation: [
    [
      'python3',
      '-c',
      "assert open('left.txt').read().strip() == 'left-ok'; assert open('right.txt').read().strip() == 'right-ok'",
    ],
  ],
});
const session = await rpc('sessions.create', {
  repo,
  pool: 'session-smoke',
  lead: 'codex-free-1',
  config,
});
console.log(`Workflow session ${session.id} · ${repo}`);
await rpc('sessions.submit', {
  id: session.id,
  clientMessageId: randomUUID(),
  input:
    'Create left.txt containing left-ok and right.txt containing right-ok. Delegate exactly two independent write tasks: left to codex-free-2 with provider codex, right to antigravity-1 with provider antigravity. The Codex task must sleep 20 seconds before writing. The Antigravity task must write and verify immediately using one shell command; do not sleep or launch asynchronous commands. Pin each account, set models null, and do not edit any other files. Please delegate now.',
});
const deadline = Date.now() + 360000;
let s;
while (Date.now() < deadline) {
  s = await rpc('sessions.snapshot', { id: session.id });
  if (['idle', 'needs_review', 'stopped'].includes(s.session.status)) break;
  await new Promise((r) => setTimeout(r, 1000));
}
if (s.session.status !== 'idle') {
  await rpc('sessions.interrupt', { id: session.id });
  throw new Error(JSON.stringify({ status: s.session.status, error: s.session.error }));
}
const delegation = s.events.find((e) => e.type === 'delegated');
assert.ok(delegation);
const run = await rpc('runs.status', { id: delegation.data.runId });
assert.equal(run.run.status, 'ready_for_review');
const events = await rpc('runs.events', { id: run.run.id });
const attempts = run.attempts;
const terminals = events.filter((e) => e.type === 'attempt_finished');
assert.equal(attempts.length, 2);
assert.notEqual(attempts[0].accountId, attempts[1].accountId);
assert.ok(
  attempts[0].startedAt < terminals.find((e) => e.attemptId === attempts[1].id).at &&
    attempts[1].startedAt < terminals.find((e) => e.attemptId === attempts[0].id).at,
);
const review = await rpc('sessions.review', { id: session.id });
assert.match(review.patch, /left-ok/);
assert.match(review.patch, /right-ok/);
await rpc('sessions.apply', { id: session.id });
assert.equal(git(['rev-parse', 'HEAD']), head);
assert.deepEqual(await readFile(path.join(repo, '.git', 'index')), index);
assert.equal(await readFile(path.join(repo, 'user.txt'), 'utf8'), 'unstaged user work\n');
assert.equal(await readFile(path.join(repo, 'untracked.txt'), 'utf8'), 'keep\n');
assert.equal((await readFile(path.join(repo, 'left.txt'), 'utf8')).trim(), 'left-ok');
assert.equal((await readFile(path.join(repo, 'right.txt'), 'utf8')).trim(), 'right-ok');
await writeFile(
  path.join(repo, 'evidence.json'),
  JSON.stringify(
    {
      sessionId: session.id,
      runId: run.run.id,
      attempts: attempts.map((a) => ({ id: a.id, accountId: a.accountId, startedAt: a.startedAt })),
      terminals,
      reviewHash: review.hash,
      headPreserved: true,
      indexPreserved: true,
    },
    null,
    2,
  ),
);
await rpc('sessions.interrupt', { id: session.id });
console.log(
  `PASS mixed provider overlap, dirty baseline, review and unstaged apply. Evidence ${repo}/evidence.json`,
);
