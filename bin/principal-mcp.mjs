#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
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
    const targetExec = await realpath(runtimeExecutable).catch(() => runtimeExecutable);

    if (currentExec !== targetExec) {
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
