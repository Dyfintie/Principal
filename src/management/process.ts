import { readFile, readlink, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Installation, ProcessIdentity, Tool } from './model.js';

/** Explicit recovery only. pidfd binds the signal to the checked process, even if its PID is reused. */
export async function forceStopOwned(identity: ProcessIdentity, wrapper: ProcessIdentity) {
  if (process.platform !== 'linux' || identity.pid === wrapper.pid)
    throw new Error('Safe force stop is unavailable for this process');
  const script = `import os, sys, json, signal
native, wrapper = json.loads(sys.argv[1])
def check(identity):
    pid = identity['pid']
    if os.stat('/proc/' + str(pid)).st_uid != os.getuid(): raise RuntimeError()
    with open('/proc/' + str(pid) + '/stat') as f: fields = f.read().rsplit(') ', 1)[1].split()
    with open('/proc/sys/kernel/random/boot_id') as f: boot = f.read().strip()
    if fields[0] in ('Z', 'X') or fields[19] != identity['startTime'] or boot != identity['bootId']: raise RuntimeError()
    return int(fields[1])
fd = os.pidfd_open(native['pid'])
try:
    parent = check(native)
    check(wrapper)
    for _ in range(64):
        if parent == wrapper['pid']: break
        if parent <= 1: raise RuntimeError()
        with open('/proc/' + str(parent) + '/stat') as f: parent = int(f.read().rsplit(') ', 1)[1].split()[1])
    else: raise RuntimeError()
    check(native)
    check(wrapper)
    signal.pidfd_send_signal(fd, signal.SIGKILL)
finally:
    os.close(fd)
`;
  try {
    await promisify(execFile)('python3', ['-c', script, JSON.stringify([identity, wrapper])], {
      timeout: 5000,
      maxBuffer: 4096,
    });
  } catch {
    throw new Error(
      'Safe force stop failed: process ownership changed or Linux/Python pidfd support is unavailable',
    );
  }
}

let cachedBootId: string | null = null;
export async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  try {
    const data = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = data.slice(data.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') return null;
    if (!cachedBootId) {
      cachedBootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    }
    return {
      pid,
      startTime: fields[19],
      bootId: cachedBootId,
    };
  } catch (e) {
    if (['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '')) return null;
    throw new Error('Process identity is inaccessible');
  }
}
export async function identityMatches(identity: ProcessIdentity) {
  const current = await processIdentity(identity.pid);
  return (
    !!current && current.startTime === identity.startTime && current.bootId === identity.bootId
  );
}
export async function ancestors(pid: number): Promise<number[]> {
  const result: number[] = [];
  for (let i = 0; i < 8 && pid > 1; i++) {
    result.push(pid);
    try {
      const s = await readFile(`/proc/${pid}/stat`, 'utf8');
      pid = Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]);
    } catch {
      break;
    }
  }
  return result;
}
export async function identifyTool(
  pid: number,
  installations: Installation[],
): Promise<Tool | null> {
  try {
    if ((await stat(`/proc/${pid}`)).uid !== process.getuid?.()) return null;
    const executable = await readlink(`/proc/${pid}/exe`);
    // Inspect only executable positions; never persist command lines or prompts.
    const args = (await readFile(`/proc/${pid}/cmdline`)).toString().split('\0');
    for (const installation of installations) {
      if (!installation.executable) continue;
      const approved = installation.processExecutables ?? [installation.executable];
      const offset = approved.includes(args[1]) ? 2 : 1;
      if (
        approved.includes(executable) ||
        approved.includes(args[0]) ||
        approved.includes(args[1])
      ) {
        const administrative = new Set([
          '--help',
          '-h',
          '--version',
          '-V',
          '-v',
          'version',
          'login',
          'logout',
          'auth',
          'app-server',
          '--server',
          '--headless',
          '--stdio',
          'doctor',
          'update',
          'install',
          'mcp',
          'plugin',
          'plugins',
          'agents',
          'agent',
          'models',
          'sessions',
          'completion',
          'remote-control',
        ]);
        if (administrative.has(args[offset] ?? '')) return null;
        return installation.tool;
      }
    }
    return null;
  } catch {
    return null;
  }
}
export async function discoverProcesses(installations: Installation[]) {
  const result: { identity: ProcessIdentity; tool: Tool; directory: string }[] = [];
  const pids = (await readdir('/proc')).filter((s) => /^\d+$/.test(s));
  // Bounded concurrency, only same-user known binaries. Coverage is deliberately conservative.
  for (let offset = 0; offset < pids.length; offset += 32) {
    const batch = await Promise.all(
      pids.slice(offset, offset + 32).map(async (value) => {
        const pid = Number(value);
        const tool = await identifyTool(pid, installations);
        if (!tool) return null;
        try {
          const identity = await processIdentity(pid);
          const directory = await readlink(`/proc/${pid}/cwd`);
          if (identity && path.isAbsolute(directory)) return { identity, tool, directory };
        } catch {}
        return null;
      }),
    );
    for (const item of batch) if (item) result.push(item);
  }
  // npm launchers remain alive while their native child runs. Show one agent.
  const wrappers = new Set<number>();
  for (const item of result) {
    const parents = (await ancestors(item.identity.pid)).slice(1);
    for (const candidate of result) {
      if (candidate.tool !== item.tool || !parents.includes(candidate.identity.pid)) continue;
      const installation = installations.find((i) => i.tool === candidate.tool);
      if (!installation?.processExecutables || installation.processExecutables.length < 2) continue;
      try {
        const args = (await readFile(`/proc/${candidate.identity.pid}/cmdline`))
          .toString()
          .split('\0');
        if (args[1] === installation.executable) wrappers.add(candidate.identity.pid);
      } catch {}
    }
  }
  return result.filter((item) => !wrappers.has(item.identity.pid));
}

/** Terminal attachment evidence, never a claim about native conversation activity. */
export async function controllingTerminal(identity: ProcessIdentity): Promise<boolean | null> {
  try {
    if (!(await identityMatches(identity))) return null;
    const raw = await readFile(`/proc/${identity.pid}/stat`, 'utf8');
    const tty = Number(raw.slice(raw.lastIndexOf(')') + 2).split(' ')[4]);
    if (!(await identityMatches(identity))) return null;
    return Number.isFinite(tty) ? tty !== 0 : null;
  } catch {
    return null;
  }
}
