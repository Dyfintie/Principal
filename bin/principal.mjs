#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';

const rebuild = 'Use Node 24+ to run npm rebuild better-sqlite3 && npm run build in the Principal directory.';
function canRunDirectly() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 24) return false;
  try {
    const Database = createRequire(import.meta.url)('better-sqlite3');
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

try {
  if (canRunDirectly()) {
    await import('../dist/cli.js');
  } else {
    let runtime;
    try {
      runtime = JSON.parse(await readFile(new URL('../dist/host-runtime.json', import.meta.url), 'utf8'));
    } catch {
      // Runtime manifest optional
    }

    const currentExec = await realpath(process.execPath).catch(() => process.execPath);
    if (runtime?.executable && currentExec !== runtime.executable) {
      const child = spawn(runtime.executable, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: process.env,
      });
      const handlers = new Map();
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        const handler = () => child.kill(signal);
        handlers.set(signal, handler);
        process.on(signal, handler);
      }
      child.once('error', (error) => {
        console.error(`Principal cannot launch its build runtime (${runtime.executable}): ${error.message}\n${rebuild}`);
        process.exitCode = 1;
      });
      child.once('exit', (code, signal) => {
        for (const [name, handler] of handlers) process.removeListener(name, handler);
        process.exitCode = code ?? (128 + (constants.signals[signal] ?? 1));
      });
    } else {
      if (Number(process.versions.node.split('.')[0]) < 24) {
        throw new Error(`Node.js 24+ is required to run Principal (current: ${process.version}).`);
      }
      const Database = createRequire(import.meta.url)('better-sqlite3');
      const db = new Database(':memory:');
      db.close();
      await import('../dist/cli.js');
    }
  }
} catch (error) {
  console.error(`Principal startup failed: ${error.message}\n${rebuild}`);
  process.exitCode = 1;
}
