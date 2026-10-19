import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Coordinator } from '../dist/coordinator.js';
import { ConfigSchema } from '../dist/schema.js';
import { git } from '../dist/repository.js';
import { sleep } from '../dist/util.js';
const coordinator = new Coordinator();
const account = coordinator.store.account(process.env.PRINCIPAL_AGY_ACCOUNT ?? 'antigravity-1');
const directory = await mkdtemp(path.join(tmpdir(), 'principal-agy-smoke-'));
const marker = randomUUID();
const timeoutSeconds = Number(process.env.PRINCIPAL_AGY_TIMEOUT ?? 240);
const config = ConfigSchema.parse({ attemptTimeoutSeconds: timeoutSeconds });
let container;
try {
  await git(directory, ['init', '-q']);
  await writeFile(path.join(directory, 'marker.txt'), marker);
  const owner = `smoke-${randomUUID()}`;
  let acquired = coordinator.store.lease(account.id, owner);
  for (let i = 0; !acquired && i < 40; i++) {
    await sleep(1000);
    acquired = coordinator.store.lease(account.id, owner);
  }
  assert.ok(acquired, 'Antigravity account is busy');
  try {
    container = await coordinator.runtime.create(account, config, { workspace: directory });
    coordinator.store.setContainer(account.id, container);
    try {
      await coordinator.runtime.call(container, {
        op: 'start',
        provider: 'antigravity',
        model: process.env.PRINCIPAL_AGY_MODEL ?? 'gemini-3.8-flash-medium',
        attemptId: randomUUID(),
        mode: 'write',
        timeoutSeconds,
        prompt:
          'Use a shell command to read /workspace/marker.txt. Write exactly that content to /workspace/result.txt using a tool. After writing, call the finish tool immediately with JSON containing marker with the exact content. Do not inspect Git, access any other files, verify your result again, or use the network.',
        setup: [],
        outputSchema: {
          type: 'object',
          properties: { marker: { type: 'string' } },
          required: ['marker'],
          additionalProperties: false,
        },
      });
      let final;
      const deadline = Date.now() + (timeoutSeconds + 20) * 1000;
      let after = 0;
      while (Date.now() < deadline) {
        await sleep(1000);
        const response = await coordinator.runtime.call(container, { op: 'status', after });
        for (const e of response.events) {
          after = e.seq;
          if (['tool', 'approval_denied', 'terminal'].includes(e.type))
            console.log(e.type, JSON.stringify(e.data));
        }
        if (['completed', 'failed'].includes(response.status?.state)) {
          final = response.status;
          break;
        }
      }
      assert.ok(final, 'worker did not finish before deadline');
      console.log(
        'Worker state:',
        final.state,
        'error:',
        final.error ?? 'none',
        'result:',
        JSON.stringify(final.result),
      );
      assert.equal(final.state, 'completed');
      assert.equal((await readFile(path.join(directory, 'result.txt'), 'utf8')).trim(), marker);
      await coordinator.runtime.snapshot(account, container);
      console.log(
        'PASS: native Antigravity stream worker executed tools and wrote the random marker with configured permissions; no bypass flag',
      );
    } finally {
      await coordinator.runtime.stop(container);
      container = null;
    }
  } finally {
    coordinator.store.release(account.id, owner);
  }
} finally {
  if (container) await coordinator.runtime.stop(container);
  coordinator.store.close();
  await rm(directory, { recursive: true, force: true });
}
