import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';
export async function loginEnvironment() {
  const environment = JSON.parse(await readFile('/run/principal/login-environment.json', 'utf8'));
  const address = (await readFile('/run/principal/dbus-address', 'utf8')).trim();
  return { ...process.env, ...environment, DBUS_SESSION_BUS_ADDRESS: address };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const child = spawn('agy', ['--output-format', 'json', '-p', '/usage'], {
    cwd: '/workspace',
    stdio: 'inherit',
    env: await loginEnvironment(),
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(signal, () => child.kill(signal));
  child.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? 128 + (constants.signals[signal] ?? 1);
  });
}
