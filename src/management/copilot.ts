import { spawn, type ChildProcess } from 'node:child_process';
import type { Installation, Profile } from './model.js';
import { nativeExecutable, profileEnvironment } from './providers.js';

// First-party SDK JSON-RPC, Content-Length framing. No session creation,
// inference, credential exports, login, or token-refresh handling.
const observers = new Set<ChildProcess>();
export function closeCopilotObservers() {
  for (const child of observers) child.kill('SIGTERM');
}
export async function copilotAuth(profile: Profile, installation: Installation) {
  const value = await copilotRead(profile, installation, 'auth.getStatus');
  if (typeof value?.isAuthenticated !== 'boolean')
    throw new Error('Copilot authentication status unavailable');
  return {
    isAuthenticated: value.isAuthenticated as boolean,
    login: typeof value.login === 'string' ? value.login : undefined,
  };
}
export async function copilotQuota(profile: Profile, installation: Installation) {
  const value = await copilotRead(profile, installation, 'account.getQuota');
  if (
    !value?.quotaSnapshots ||
    typeof value.quotaSnapshots !== 'object' ||
    Array.isArray(value.quotaSnapshots)
  )
    throw new Error('Copilot quota unavailable; check native /usage');
  // Normalize through a strict allowlist before any persistence or display.
  const snapshots: Record<
    string,
    {
      remainingPercentage?: number;
      entitlementRequests?: number;
      usedRequests?: number;
      resetDate?: string;
      isUnlimitedEntitlement?: boolean;
    }
  > = {};
  for (const [key, raw] of Object.entries(value.quotaSnapshots).slice(0, 30)) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || !raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const snapshot: (typeof snapshots)[string] = {};
    for (const field of ['remainingPercentage', 'entitlementRequests', 'usedRequests'] as const)
      if (typeof item[field] === 'number' && Number.isFinite(item[field]))
        snapshot[field] = item[field];
    if (typeof item.resetDate === 'string' && Number.isFinite(Date.parse(item.resetDate)))
      snapshot.resetDate = new Date(item.resetDate).toISOString();
    if (typeof item.isUnlimitedEntitlement === 'boolean')
      snapshot.isUnlimitedEntitlement = item.isUnlimitedEntitlement;
    snapshots[key] = snapshot;
  }
  return snapshots;
}
async function copilotRead(
  profile: Profile,
  installation: Installation,
  method: 'auth.getStatus' | 'account.getQuota',
): Promise<any> {
  if (!installation.verifiedVersion || !installation.executable)
    throw new Error('Copilot authentication inspection is disabled for this version');
  const executable = nativeExecutable(installation)!;
  if (executable.endsWith('/@github/copilot/npm-loader.js'))
    throw new Error('Copilot native runtime could not be resolved');
  const child = spawn(
    executable,
    ['--headless', '--stdio', '--no-auto-update', '--log-level', 'none'],
    {
      cwd: profile.directory,
      env: profileEnvironment(profile),
      stdio: ['pipe', 'pipe', 'ignore'],
    },
  );
  observers.add(child);
  child.once('exit', () => observers.delete(child));
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await new Promise<any>((resolve, reject) => {
      let buffer = Buffer.alloc(0),
        total = 0,
        settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        reject(new Error('Copilot observation unavailable; use native /user or /usage'));
      };
      timer = setTimeout(fail, 10_000);
      child.on('error', fail);
      child.on('exit', fail);
      child.stdin.on('error', fail);
      child.stdout.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > 128 * 1024) {
          fail();
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) return;
          const match = buffer
            .subarray(0, end)
            .toString()
            .match(/Content-Length:\s*(\d+)/i);
          if (!match) {
            fail();
            return;
          }
          const length = Number(match[1]);
          if (length > 128 * 1024) {
            fail();
            return;
          }
          if (buffer.length < end + 4 + length) return;
          const body = buffer.subarray(end + 4, end + 4 + length);
          buffer = buffer.subarray(end + 4 + length);
          try {
            const value = JSON.parse(body.toString());
            if (value.id === 1 && ('result' in value || 'error' in value)) {
              if (value.error || !value.result || typeof value.result !== 'object') {
                fail();
                return;
              }
              if (!settled) {
                settled = true;
                resolve(value.result);
              }
            } else if (value.method && value.id !== undefined) {
              const reply = JSON.stringify({
                jsonrpc: '2.0',
                id: value.id,
                error: { code: -32601, message: 'Observations only' },
              });
              child.stdin.write(`Content-Length: ${Buffer.byteLength(reply)}\r\n\r\n${reply}`);
            }
          } catch {
            fail();
            return;
          }
        }
      });
      const request = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {},
      });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`);
    });
  } finally {
    clearTimeout(timer!);
    child.stdin.end();
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 2000);
    killer.unref();
    child.once('exit', () => clearTimeout(killer));
  }
}
