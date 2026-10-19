import { readFile, readdir, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
let executable = process.execPath;
try {
  const recorded = JSON.parse(
    await readFile(new URL('../dist/host-runtime.json', import.meta.url), 'utf8'),
  ).executable;
  if (Number(process.versions.node.split('.')[0]) < 24 && recorded) {
    executable = recorded;
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
function run(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Workflow failed (${code ?? signal})`)),
    );
  });
}
try {
  const currentExec = await realpath(process.execPath).catch(() => process.execPath);
  const targetExec = await realpath(executable).catch(() => executable);
  if (currentExec !== targetExec) {
    await run(targetExec, [fileURLToPath(import.meta.url), ...process.argv.slice(2)]);
  } else {
    if (Number(process.versions.node.split('.')[0]) < 24)
      throw new Error(
        'Use Node 24+ for the first build; subsequent workflows use the recorded runtime.',
      );
    const task = process.argv[2];
    const smoke = ['runtime-smoke', 'login-smoke', 'live-smoke', 'antigravity-smoke'];
    if (smoke.includes(task)) {
      await run(executable, [`scripts/${task}.mjs`]);
    } else {
      if (!['build', 'test', 'check'].includes(task)) throw new Error('Unknown workflow');
      await run(executable, [
        'node_modules/typescript/bin/tsc',
        ...(task === 'check' ? ['--noEmit'] : []),
      ]);
      if (task !== 'check') {
        for (const file of (await readdir(new URL('../runtime/', import.meta.url))).filter((f) =>
          f.endsWith('.mjs'),
        ))
          await run(executable, ['--check', `runtime/${file}`]);
        await run(executable, ['--check', 'bin/principal.mjs']);
        await run(executable, ['scripts/record-runtime.mjs']);
      }
      if (task === 'test') {
        const tests = (await readdir(new URL('../tests/', import.meta.url)))
          .filter((f) => f.endsWith('.test.mjs'))
          .map((f) => `tests/${f}`);
        await run(executable, ['--test', ...tests]);
      }
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
