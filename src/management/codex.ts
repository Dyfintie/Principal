import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Installation, Profile } from './model.js';
import { profileEnvironment } from './providers.js';

// Only first-party read methods. Never log raw protocol messages, perform login,
// resume/start threads, request turns, or implement externally managed tokens.
const reads = new Set(['account/read', 'account/rateLimits/read', 'thread/list', 'thread/read']);
const observers = new Set<ChildProcess>();
export class CodexRpcError extends Error {
  readonly category: 'authentication' | 'network' | 'rate-limit' | 'permission' | 'rpc';
  readonly status?: number;
  constructor(
    readonly code?: number,
    message = '',
  ) {
    // Classify locally; never retain raw provider messages/data, which may contain tokens.
    const status =
      code && [401, 403, 429].includes(code)
        ? code
        : /\b401\b|unauthorized|not authenticated|invalid (?:access |refresh )?token|(?:access |refresh )?token.{0,30}(?:expired|revoked|reused)/i.test(
              message,
            )
          ? 401
          : /\b403\b|forbidden/i.test(message)
            ? 403
            : /\b429\b|too many requests/i.test(message)
              ? 429
              : undefined;
    const category =
      status === 401
        ? 'authentication'
        : status === 403
          ? 'permission'
          : status === 429
            ? 'rate-limit'
            : /network|connection|connect|timed out|timeout|dns|unreachable/i.test(message)
              ? 'network'
              : 'rpc';
    super(
      category === 'authentication'
        ? 'Codex authentication rejected (401 Unauthorized). Sign in to this profile again.'
        : category === 'permission'
          ? 'Codex access denied (403). Check account permissions.'
          : category === 'rate-limit'
            ? 'Codex read throttled (429). Wait before retrying.'
            : category === 'network'
              ? 'Codex connection unavailable. Check network connectivity.'
              : 'Codex read failed. Check native authentication and CLI compatibility.',
    );
    this.name = 'CodexRpcError';
    this.category = category;
    this.status = status;
  }
}
export function closeCodexObservers() {
  for (const child of observers) child.kill('SIGTERM');
}
export async function codexRead(
  profile: Profile,
  installation: Installation,
  requests: { method: string; params?: unknown }[],
) {
  if (!installation.verifiedVersion || !installation.executable)
    throw new Error('Codex read integration is disabled for this version');
  if (requests.some((r) => !reads.has(r.method)))
    throw new Error('Unsupported Codex read operation');
  return codexRequests(profile, installation, requests);
}

// Only used on a temporary, credential-free history snapshot. No turns are
// requested: Codex creates a native fork with a fresh conversation identity.
export async function codexForkSnapshot(
  directory: string,
  installation: Installation,
  nativeId: string,
  cwd: string,
) {
  const env = profileEnvironment({ tool: 'codex', directory } as Profile);
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_AUTH_JSON'])
    delete env[key];
  return codexRequests(
    { directory } as Profile,
    installation,
    [{ method: 'thread/fork', params: { threadId: nativeId, cwd, excludeTurns: true } }],
    env,
  );
}

async function codexRequests(
  profile: Profile,
  installation: Installation,
  requests: { method: string; params?: unknown }[],
  env = profileEnvironment(profile),
) {
  if (!installation.verifiedVersion || !installation.executable)
    throw new Error('Codex integration is disabled for this version');
  const child = spawn(installation.executable, ['app-server', '--listen', 'stdio://'], {
    cwd: profile.directory,
    env,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  observers.add(child);
  child.once('exit', () => observers.delete(child));
  const lines = createInterface({ input: child.stdout });
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; method: string }
  >();
  let bytes = 0;
  let failed: Error | null = null;
  const fail = (message: string) => {
    failed ??= new CodexRpcError(undefined, message);
    for (const item of pending.values()) item.reject(failed);
    pending.clear();
  };
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) {
      fail('Codex read response exceeded limit');
      child.kill('SIGTERM');
    }
  });
  child.on('error', () => fail('Codex read process could not start'));
  child.stdin.on('error', () => fail('Codex read process disconnected'));
  child.on('exit', () => fail('Codex read process exited'));
  lines.on('line', (line) => {
    try {
      const value = JSON.parse(line);
      const item = pending.get(value.id);
      if (item && ('result' in value || 'error' in value)) {
        pending.delete(value.id);
        const result = value.result;
        if (
          !value.error &&
          ['account/read', 'account/rateLimits/read'].includes(item.method) &&
          (!result ||
            typeof result !== 'object' ||
            Array.isArray(result) ||
            (item.method === 'account/read'
              ? !('account' in result) ||
                (result.account !== null &&
                  (typeof result.account !== 'object' || Array.isArray(result.account)))
              : !('rateLimits' in result || 'rateLimitsByLimitId' in result)))
        ) {
          item.reject(new CodexRpcError(undefined, 'Unsupported native response contract'));
          return;
        }
        value.error
          ? item.reject(
              new CodexRpcError(
                typeof value.error.code === 'number' ? value.error.code : undefined,
                typeof value.error.message === 'string' ? value.error.message : '',
              ),
            )
          : item.resolve(value.result);
      } else if (value.method && value.id !== undefined) {
        // Explicitly decline server token-refresh requests instead of handling tokens.
        child.stdin.write(
          JSON.stringify({
            id: value.id,
            error: { code: -32601, message: 'Principal supports observations only' },
          }) + '\n',
        );
      }
    } catch {}
  });
  const request = (method: string, params?: unknown) =>
    new Promise<any>((resolve, reject) => {
      if (failed) {
        reject(failed);
        return;
      }
      const id = ++nextId;
      pending.set(id, { resolve, reject, method });
      child.stdin.write(
        JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }) + '\n',
      );
    });
  const timeout = setTimeout(() => {
    fail('Codex observation timed out');
    child.kill('SIGTERM');
  }, 12_000);
  try {
    await request('initialize', {
      clientInfo: { name: 'principal_observer', title: 'Principal', version: '0.1.0' },
      capabilities: { experimentalApi: requests.some((r) => r.method === 'thread/fork') },
    });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const results = [];
    for (const r of requests) results.push(await request(r.method, r.params));
    return results;
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.end();
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 2000);
    killer.unref();
    child.once('exit', () => clearTimeout(killer));
    if (
      requests.some((r) => r.method === 'thread/fork') &&
      child.exitCode === null &&
      child.signalCode === null
    )
      await new Promise<void>((resolve) => {
        const wait = setTimeout(resolve, 2500);
        child.once('exit', () => {
          clearTimeout(wait);
          resolve();
        });
      });
  }
}
