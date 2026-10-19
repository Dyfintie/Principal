import path from 'node:path';
import { homedir, hostname } from 'node:os';
import { mkdir, chmod, lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const managementPaths = (() => {
  const state = path.join(
    process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local/state'),
    'principal',
    'management',
  );
  const runtime = process.env.XDG_RUNTIME_DIR
    ? path.join(process.env.XDG_RUNTIME_DIR, 'principal-management')
    : state;
  return {
    state,
    runtime,
    socket: path.join(runtime, 'manager.sock'),
    db: path.join(state, 'manager.sqlite'),
    profiles: path.join(state, 'profiles'),
    lock: path.join(state, 'manager.lock'),
  };
})();
export async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const s = await lstat(directory);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.())
    throw new Error(
      'Management directory must be owned by the current user and cannot be a symlink',
    );
  await chmod(directory, 0o700);
}
export async function initManagementPaths() {
  if (process.platform !== 'linux')
    throw new Error('Native management currently supports Linux and WSL');
  for (const directory of new Set([
    managementPaths.state,
    managementPaths.runtime,
    managementPaths.profiles,
  ]))
    await privateDirectory(directory);
}
export async function environment() {
  let machine = hostname();
  try {
    machine = (await readFile('/etc/machine-id', 'utf8')).trim();
  } catch {}
  const distribution = process.env.WSL_DISTRO_NAME ?? '';
  return {
    id: createHash('sha256')
      .update(`${machine}:${process.getuid?.()}:${distribution}`)
      .digest('hex')
      .slice(0, 24),
    platform: process.platform,
    name: distribution ? `WSL · ${distribution}` : `Linux · ${hostname()}`,
  };
}
