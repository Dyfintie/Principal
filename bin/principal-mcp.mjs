#!/usr/bin/env node
import { readFile, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
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
    const { startMcpStdioServer } = await import('../dist/mcp/server.js');
    startMcpStdioServer();
  } else {
    let runtimeExecutable = process.execPath;
    try {
      const runtime = JSON.parse(await readFile(new URL('../dist/host-runtime.json', import.meta.url), 'utf8'));
      runtimeExecutable = runtime.executable;
    } catch {
      // Fall back to current process.execPath if host-runtime.json is absent
    }

    const currentExec = await realpath(process.execPath).catch(() => process.execPath);
    let targetExec = null;
    if (runtimeExecutable && runtimeExecutable !== 'node') {
      const isAvailable = await stat(runtimeExecutable).catch(() => null);
      if (isAvailable && currentExec !== runtimeExecutable) {
        targetExec = runtimeExecutable;
      }
    }

    if (!targetExec) {
      for (const candidate of ['/usr/bin/node', '/usr/local/bin/node', '/opt/homebrew/bin/node']) {
        if (candidate !== currentExec && await stat(candidate).catch(() => null)) {
          targetExec = candidate;
          break;
        }
      }
    }

    if (targetExec) {
      const child = spawn(targetExec, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: process.env,
      });
      child.once('exit', (code) => {
        process.exitCode = code ?? 0;
      });
    } else {
      const { startMcpStdioServer } = await import('../dist/mcp/server.js');
      startMcpStdioServer();
    }
  }
} catch (error) {
  console.error(`Principal MCP startup failed: ${error.message}\n${rebuild}`);
  process.exitCode = 1;
}
