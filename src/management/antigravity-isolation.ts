import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdtemp, rm, stat } from 'node:fs/promises';
import { readFileSync, writeSync, closeSync } from 'node:fs';
import { tmpdir, constants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { exec } from '../util.js';
import { privateDirectory, managementPaths } from './paths.js';
import { findExecutable } from './providers.js';
import type { Profile } from './model.js';
import { startBrowserBridge } from './browser-bridge.js';
import { ensureSharedHistory } from './shared-history.js';

/** A private HOME alone is insufficient: native Google login also uses Secret Service. */
export async function isolatedAntigravityLaunch(
  profile: Profile,
  spec: { executable: string; args: readonly string[]; env: NodeJS.ProcessEnv },
) {
  const home = path.join(managementPaths.profiles, profile.id);
  if (profile.directory !== path.join(home, '.gemini', 'antigravity-cli'))
    throw new Error('Antigravity isolated profile directory is invalid');
  await privateDirectory(home);
  await ensureSharedHistory(profile);
  const secretTool = await findExecutable('secret-tool');
  const gdbus = await findExecutable('gdbus');
  if (!secretTool || !gdbus) {
    const tokenFile = path.join(profile.directory, 'antigravity-oauth-token');
    const hasToken = await stat(tokenFile).then(() => true, () => false);
    if (hasToken) {
      return {
        executable: spec.executable,
        args: [...spec.args],
        env: {
          ...spec.env,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, '.config'),
          XDG_DATA_HOME: path.join(home, '.local', 'share'),
          XDG_CACHE_HOME: path.join(home, '.cache'),
          XDG_STATE_HOME: path.join(home, '.local', 'state'),
          XDG_RUNTIME_DIR: undefined,
          PRINCIPAL_MANAGEMENT_SOCKET: managementPaths.socket,
        },
        keyringPassword: undefined,
        trackNativePid: true,
        cleanup: undefined,
      };
    }
    throw new Error('Install secret-tool and gdbus for isolated Antigravity logins');
  }
  const service = await exec(
    gdbus,
    [
      'call',
      '--session',
      '--dest',
      'org.freedesktop.DBus',
      '--object-path',
      '/org/freedesktop/DBus',
      '--method',
      'org.freedesktop.DBus.NameHasOwner',
      'org.freedesktop.secrets',
    ],
    { timeout: 5000, maxBytes: 4096, allowFailure: true },
  );
  if (service.code !== 0 || !service.stdout.toString().includes('true'))
    throw new Error(
      'Unlock your desktop Secret Service before launching an isolated Antigravity profile',
    );
  const attributes = ['application', 'principal-antigravity-profile', 'profile', profile.id];
  const saved = await exec(secretTool, ['lookup', ...attributes], {
    timeout: 8000,
    maxBytes: 4096,
    allowFailure: true,
  });
  let password = saved.stdout.toString().trim();
  if (!password) {
    const keyring = path.join(home, '.local', 'share', 'keyrings', 'login.keyring');
    if (
      await lstat(keyring).then(
        () => true,
        (e) => {
          if (e.code === 'ENOENT') return false;
          throw e;
        },
      )
    )
      throw new Error(
        'Profile keyring password is unavailable. Unlock the desktop keyring; this profile will not be reset',
      );
    password = randomBytes(32).toString('base64');
    await exec(
      secretTool,
      ['store', '--label=Principal Antigravity profile keyring', ...attributes],
      {
        input: password,
        timeout: 8000,
        maxBytes: 4096,
      },
    );
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(password))
    throw new Error('Invalid profile keyring password in Secret Service');
  const runtime = await mkdtemp(path.join(tmpdir(), 'principal-agy-'));
  let browser: Awaited<ReturnType<typeof startBrowserBridge>> | undefined;
  try {
    browser = opener ? await startBrowserBridge(runtime, opener) : undefined;
  } catch {
    /* Native printed login links remain usable without a desktop bridge. */
  }
  return {
    executable: process.execPath,
    args: [fileURLToPath(import.meta.url), spec.executable, ...spec.args],
    env: {
      ...spec.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_STATE_HOME: path.join(home, '.local', 'state'),
      XDG_RUNTIME_DIR: runtime,
      ...(browser
        ? {
            PATH: browser.bin + path.delimiter + (spec.env.PATH ?? ''),
            PRINCIPAL_BROWSER_SOCKET: browser.socket,
          }
        : {}),
      PRINCIPAL_MANAGEMENT_SOCKET: managementPaths.socket,
    },
    keyringPassword: Buffer.from(password),
    trackNativePid: true,
    cleanup: async () => {
      if (browser?.close) await browser.close().catch(() => {});
      await removeIsolatedRuntime(runtime).catch(() => {});
    },
  };
}

export async function removeIsolatedRuntime(runtime: string) {
  if (path.dirname(runtime) !== tmpdir() || !path.basename(runtime).startsWith('principal-agy-'))
    throw new Error('Invalid isolated runtime directory');
  const metadata = await lstat(runtime).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!metadata) return;
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid?.() ||
    metadata.mode & 0o077
  )
    throw new Error('Unsafe isolated runtime directory');
  await rm(runtime, { recursive: true, force: true });
}

/** Internal foreground helper. Password arrives on fd 3, never argv, env, or disk. */
async function runIsolated() {
  process.umask(0o077);
  const home = process.env.HOME!;
  const runtime = process.env.XDG_RUNTIME_DIR!;
  for (const directory of [
    home,
    runtime,
    path.join(home, '.config'),
    path.join(home, '.cache'),
    path.join(home, '.local', 'share', 'keyrings'),
    path.join(home, '.local', 'state'),
  ])
    await privateDirectory(directory);
  const dbusBinary = await findExecutable('dbus-daemon');
  const keyringBinary = await findExecutable('gnome-keyring-daemon');
  const gdbus = await findExecutable('gdbus');
  if (!dbusBinary || !keyringBinary || !gdbus)
    throw new Error('Isolated login requires dbus-daemon, gnome-keyring-daemon and gdbus');
  const socket = path.join(runtime, 'bus');
  let native: ChildProcess | undefined;
  let keyring: ChildProcess | undefined;
  let bus: ChildProcess | undefined;
  let stopping = false;
  const terminate = () => {
    stopping = true;
    native?.kill('SIGTERM');
  };
  const interrupt = () => {
    /* Foreground native CLI receives terminal SIGINT directly. */
  };
  process.on('SIGTERM', terminate);
  process.on('SIGHUP', terminate);
  process.on('SIGINT', interrupt);
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${socket}`,
    };
    delete env.GNOME_KEYRING_CONTROL;
    delete env.DBUS_STARTER_ADDRESS;
    delete env.DBUS_STARTER_BUS_TYPE;
    bus = spawn(dbusBinary, ['--session', '--nofork', `--address=unix:path=${socket}`], {
      env,
      stdio: 'ignore',
    });
    bus.on('error', () => {
      stopping = true;
      native?.kill('SIGTERM');
    });
    bus.on('exit', () => {
      stopping = true;
      native?.kill('SIGTERM');
    });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (stopping) throw new Error('Private D-Bus failed to start');
      const ready = await exec(
        gdbus,
        [
          'call',
          '--session',
          '--dest',
          'org.freedesktop.DBus',
          '--object-path',
          '/org/freedesktop/DBus',
          '--method',
          'org.freedesktop.DBus.NameHasOwner',
          'org.freedesktop.DBus',
        ],
        { env, timeout: 1000, maxBytes: 4096, allowFailure: true },
      );
      if (ready.code === 0) break;
      if (attempt === 49) throw new Error('Private D-Bus startup timed out');
      await new Promise((r) => setTimeout(r, 100));
    }
    const control = path.join(runtime, 'keyring');
    await privateDirectory(control);
    env.GNOME_KEYRING_CONTROL = control;
    const password = readFileSync(3);
    closeSync(3);
    if (!/^[A-Za-z0-9+/]{43}=$/.test(password.toString()))
      throw new Error('Missing isolated keyring password');
    keyring = spawn(
      keyringBinary,
      ['--foreground', '--login', '--components=secrets', `--control-directory=${control}`],
      { env, stdio: ['pipe', 'ignore', 'ignore'] },
    );
    keyring.on('error', () => {
      stopping = true;
      native?.kill('SIGTERM');
    });
    keyring.on('exit', () => {
      stopping = true;
      native?.kill('SIGTERM');
    });
    keyring.stdin!.on('error', () => {
      stopping = true;
      native?.kill('SIGTERM');
    });
    keyring.stdin!.end(password, () => password.fill(0));
    await new Promise((r) => setTimeout(r, 200));
    await exec(
      keyringBinary,
      ['--start', '--components=secrets', `--control-directory=${control}`],
      { env, timeout: 5000, maxBytes: 4096 },
    );
    if (stopping) throw new Error('Private keyring failed to start');
    const unlocked = await exec(
      gdbus,
      [
        'call',
        '--session',
        '--dest',
        'org.freedesktop.secrets',
        '--object-path',
        '/org/freedesktop/secrets/collection/login',
        '--method',
        'org.freedesktop.DBus.Properties.Get',
        'org.freedesktop.Secret.Collection',
        'Locked',
      ],
      { env, timeout: 5000, maxBytes: 4096, allowFailure: true },
    );
    if (unlocked.code !== 0 || !unlocked.stdout.toString().includes('false'))
      throw new Error('Private profile keyring is locked; native login was not started');
    native = spawn(process.argv[2], process.argv.slice(3), { env, stdio: 'inherit' });
    const exited = once(native, 'exit');
    void exited.catch(() => {});
    await once(native, 'spawn');
    writeSync(4, JSON.stringify({ pid: native.pid }) + '\n');
    closeSync(4);
    const [code, signal] = await exited;
    process.exitCode =
      code ?? (signal ? 128 + (constants.signals[signal as NodeJS.Signals] ?? 1) : 1);
  } finally {
    native?.kill('SIGTERM');
    keyring?.kill('SIGTERM');
    bus?.kill('SIGTERM');
    for (const child of [native, keyring, bus]) {
      if (child && child.exitCode === null && child.signalCode === null) {
        await Promise.race([
          once(child, 'exit').catch(() => {}),
          new Promise((r) => setTimeout(r, 1500)),
        ]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
    await removeIsolatedRuntime(runtime);
    process.off('SIGTERM', terminate);
    process.off('SIGHUP', terminate);
    process.off('SIGINT', interrupt);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await runIsolated().catch(() => {
    console.error(
      'Antigravity isolated runtime could not start; check keyring dependencies and /diagnostics.',
    );
    process.exitCode = 1;
  });
