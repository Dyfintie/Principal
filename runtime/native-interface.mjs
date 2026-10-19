import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
const provider = process.argv[2];
if (!['codex', 'antigravity'].includes(provider)) throw new Error('Unknown native provider');
const address = (await readFile('/run/principal/dbus-address', 'utf8')).trim();
// Docker supplies the sandbox; native Codex's nested Bubblewrap is unavailable here.
const args = provider === 'codex' ? ['--no-daemon', '--sandbox', 'danger-full-access'] : [];
if (process.argv[3]) args.push('--model', process.argv[3]);
const child = spawn(provider === 'codex' ? 'codex' : 'agy', args, {
  cwd: process.cwd(), stdio: 'inherit', env: { ...process.env, HOME: '/home/principal', DBUS_SESSION_BUS_ADDRESS: address },
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? 128 + (constants.signals[signal] ?? 1); });
