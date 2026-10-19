import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { rpc } from '../dist/client.js';
import { ConfigSchema } from '../dist/schema.js';
const repo = await mkdtemp(path.join(tmpdir(), 'principal-live-smoke-'));
const markers = [randomUUID(), randomUUID()];
for (let i = 0; i < 2; i++) await writeFile(path.join(repo, `marker-${i}.txt`), markers[i]);
const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
git(['init', '-q']);
git(['add', '.']);
git([
  '-c',
  'user.name=Principal Smoke',
  '-c',
  'user.email=principal-smoke@localhost',
  'commit',
  '-qm',
  'Add smoke fixtures',
]);
const graph = {
  schemaVersion: 1,
  pool: 'development',
  tasks: [
    ...markers.map((_, i) => ({
      id: `read-${i}`,
      account: `codex-free-${i + 1}`,
      provider: 'codex',
      mode: 'read',
      dependsOn: [],
      writePaths: [],
      expectedOutputs: ['summary'],
      allowFallback: false,
      instruction: `Use the command tool to read /workspace/marker-${i}.txt. Return its exact contents in your summary. Also use a command to verify that creating /workspace/forbidden-${i}.txt fails because the filesystem is read-only. Report completed only if both checks succeed; otherwise blocked. Do not access credentials or other accounts.`,
    })),
    {
      id: 'write-check',
      account: 'codex-free-1',
      provider: 'codex',
      mode: 'write',
      dependsOn: ['read-0', 'read-1'],
      writePaths: ['result.md'],
      expectedOutputs: ['patch', 'summary'],
      allowFallback: false,
      instruction:
        'Create result.md containing exactly principal-write-ok followed by a newline. Do not change other files. Report completed after reading back the file.',
    },
  ],
};
const config = ConfigSchema.parse({
  attemptTimeoutSeconds: 180,
  validation: [
    ['python3', '-c', 'assert open("result.md").read().strip() == "principal-write-ok"'],
  ],
});
const run = await rpc('runs.create', { repo, graph, config });
console.log(`Live smoke run ${run.id}\nRepository ${repo}`);
await writeFile(
  '/tmp/principal-live-smoke-current.json',
  JSON.stringify({ id: run.id, repo, markers }),
);
const deadline = Date.now() + 300000;
let state;
while (Date.now() < deadline) {
  state = await rpc('runs.status', { id: run.id });
  console.log(state.run.status + ' · ' + state.tasks.map((t) => t.id + ':' + t.status).join(' · '));
  if (!['queued', 'running', 'waiting_quota'].includes(state.run.status)) break;
  await new Promise((r) => setTimeout(r, 5000));
}
const evidence = path.join(tmpdir(), `principal-live-smoke-${run.id}.json`);
await writeFile(evidence, JSON.stringify(state, null, 2));
if (['queued', 'running', 'waiting_quota'].includes(state.run.status))
  await rpc('runs.cancel', { id: run.id });
if (state.run.status !== 'ready_for_review')
  throw new Error('Live smoke failed; inspect ' + evidence);
for (let i = 0; i < 2; i++) {
  const result = JSON.parse(state.tasks.find((t) => t.id === `read-${i}`).result);
  if (!result.summary.includes(markers[i])) throw new Error('Worker did not return exact marker');
}
const first = state.attempts.find((a) => a.taskId === 'read-0');
const second = state.attempts.find((a) => a.taskId === 'read-1');
const events = await rpc('runs.events', { id: run.id, after: 0 });
const end0 = events.find((e) => e.taskId === 'read-0' && e.type === 'attempt_finished').at;
const end1 = events.find((e) => e.taskId === 'read-1' && e.type === 'attempt_finished').at;
if (!(first.startedAt < end1 && second.startedAt < end0 && first.accountId !== second.accountId))
  throw new Error('No parallel overlap');
if (
  (await readFile(path.join(state.run.integration, 'result.md'), 'utf8')) !== 'principal-write-ok\n'
)
  throw new Error('Integrated file mismatch');
console.log(
  'PASS: parallel reads on separate accounts, exact unpredictable markers, read-only enforcement, writing task, integration and credential-free validation.',
);

await rpc('runs.apply', { id: run.id });
if ((await readFile(path.join(repo, 'result.md'), 'utf8')) !== 'principal-write-ok\n')
  throw new Error('Applied file mismatch');
console.log('PASS: apply fast-forwarded the isolated smoke repository.');
