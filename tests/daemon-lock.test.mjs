import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
test('direct daemon entry retains its lifetime lock and creates a private socket', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'principal-daemon-lock-'));
  const env = { ...process.env, XDG_STATE_HOME: directory, XDG_CONFIG_HOME: directory };
  delete env.PRINCIPAL_DAEMON_LOCKED;
  const first = spawn(process.execPath, ['dist/daemon.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  first.stdout.on('data', (b) => {
    output += b;
  });
  first.stderr.on('data', (b) => {
    output += b;
  });
  try {
    for (let i = 0; i < 100 && !output.includes('coordinator ready'); i++) await delay(50);
    assert.match(output, /coordinator ready/);
    const socket = path.join(directory, 'principal/daemon.sock');
    const before = await stat(socket);
    assert.equal(before.mode & 0o777, 0o600);
    const second = spawn(process.execPath, ['dist/daemon.js'], { env, stdio: 'ignore' });
    const [code] = await once(second, 'exit');
    assert.equal(code, 1);
    assert.equal((await stat(socket)).ino, before.ino);
  } finally {
    const exit = once(first, 'exit');
    first.kill('SIGTERM');
    await exit;
    await rm(directory, { recursive: true, force: true });
  }
});
