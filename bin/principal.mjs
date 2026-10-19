#!/usr/bin/env node
import { readFile, realpath, stat, readdir } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
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

async function findWorkingNodeRuntime() {
  const home = process.env.HOME || '';
  const currentExec = await realpath(process.execPath).catch(() => process.execPath);
  const candidates = [];

  const addCandidate = (p) => {
    if (p && !candidates.includes(p)) candidates.push(p);
  };

  // 1. Check host-runtime.json if recorded and valid
  try {
    const runtime = JSON.parse(await readFile(new URL('../dist/host-runtime.json', import.meta.url), 'utf8'));
    if (runtime?.executable && runtime.executable !== 'node') {
      addCandidate(runtime.executable);
    }
  } catch {}

  // 2. FNM paths
  if (home) {
    addCandidate(`${home}/.local/share/fnm/aliases/default/bin/node`);
    addCandidate(`${home}/.local/share/fnm/current/bin/node`);
    try {
      const fnmDir = `${home}/.local/share/fnm/node-versions`;
      const entries = await readdir(fnmDir).catch(() => []);
      for (const entry of entries) {
        if (entry.startsWith('v24') || entry.startsWith('v25')) {
          addCandidate(`${fnmDir}/${entry}/installation/bin/node`);
        }
      }
    } catch {}

    // 3. NVM paths
    addCandidate(`${home}/.nvm/current/bin/node`);
    try {
      const nvmDir = `${home}/.nvm/versions/node`;
      const entries = await readdir(nvmDir).catch(() => []);
      for (const entry of entries) {
        if (entry.startsWith('v24') || entry.startsWith('v25')) {
          addCandidate(`${nvmDir}/${entry}/bin/node`);
        }
      }
    } catch {}

    // 4. Volta / ASDF / local paths
    addCandidate(`${home}/.volta/bin/node`);
    addCandidate(`${home}/.local/bin/node`);
  }

  // 5. System paths
  addCandidate('/usr/local/bin/node');
  addCandidate('/opt/homebrew/bin/node');
  addCandidate('/usr/bin/node');

  let sqlitePath = '';
  try {
    sqlitePath = createRequire(import.meta.url).resolve('better-sqlite3');
  } catch {}

  for (const candidate of candidates) {
    if (candidate === currentExec) continue;
    const isAvailable = await stat(candidate).catch(() => null);
    if (!isAvailable) continue;

    try {
      const testScript = sqlitePath
        ? `if(Number(process.versions.node.split('.')[0])<24)process.exit(1);const D=require(${JSON.stringify(sqlitePath)});const d=new D(':memory:');d.close();`
        : `if(Number(process.versions.node.split('.')[0])<24)process.exit(1);`;
      execFileSync(candidate, ['-e', testScript], { stdio: 'ignore', timeout: 3000 });
      return candidate;
    } catch {
      // Incompatible Node candidate, try next
    }
  }

  return null;
}

try {
  if (canRunDirectly()) {
    await import('../dist/cli.js');
  } else {
    const targetExec = await findWorkingNodeRuntime();

    if (targetExec) {
      const child = spawn(targetExec, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
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
        console.error(`Principal cannot launch runtime (${targetExec}): ${error.message}\n${rebuild}`);
        process.exitCode = 1;
      });
      child.once('exit', (code, signal) => {
        for (const [name, handler] of handlers) process.removeListener(name, handler);
        process.exitCode = code ?? (128 + (constants.signals[signal] ?? 1));
      });
    } else {
      if (Number(process.versions.node.split('.')[0]) < 24) {
        throw new Error(
          `Node.js 24+ is required to run Principal (current: ${process.version}).\n` +
          `Please install or switch to Node 24 (e.g. 'nvm install 24 && nvm use 24' or 'fnm install 24 && fnm default 24').`
        );
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
