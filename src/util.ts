import { spawn } from 'node:child_process';
import { mkdir, readFile, open, rm, rename, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redact } from '../runtime/redaction.mjs';
export { redact };
export const paths = (() => {
  const state = path.join(
    process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local/state'),
    'principal',
  );
  return {
    state,
    config: path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'principal'),
    socket: path.join(state, 'daemon.sock'),
    db: path.join(state, 'principal.sqlite'),
    vault: path.join(state, 'vault'),
    runs: path.join(state, 'runs'),
  };
})();
export async function initPaths() {
  for (const dir of [paths.state, paths.config, paths.vault, paths.runs]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
}
export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export function cleanText(s: string) {
  return s
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
export async function atomicWrite(file: string, data: string | Buffer, mode = 0o600) {
  const temp = `${file}.${uid()}.tmp`;
  try {
    const handle = await open(temp, 'wx', mode);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
    const directory = await open(path.dirname(file), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temp, { force: true });
  }
}
export async function jsonFile(file: string) {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}
export interface ExecResult {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
}
export function exec(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    input?: Buffer | string;
    timeout?: number;
    maxBytes?: number;
    env?: NodeJS.ProcessEnv;
    allowFailure?: boolean;
  } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [],
      err: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const collect = (list: Buffer[]) => (data: Buffer) => {
      bytes += data.length;
      if (bytes > (options.maxBytes ?? 64 * 1024 * 1024)) {
        failure = new Error(`${command} exceeded output limit`);
        child.kill('SIGKILL');
      } else list.push(data);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.on('error', reject);
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => {
      failure = new Error(`${command} timed out`);
      child.kill('SIGKILL');
    }, options.timeout ?? 30000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const result = { stdout: Buffer.concat(out), stderr: Buffer.concat(err), code: code ?? 1 };
      if (failure) reject(failure);
      else if (result.code && !options.allowFailure)
        reject(
          new Error(
            redact(`${command} failed (${result.code}): ${result.stderr.toString().slice(-4000)}`),
          ),
        );
      else resolve(result);
    });
    child.stdin.end(options.input);
  });
}
export function interactive(command: string, args: string[], env = process.env) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`${command} exited ${c}`))));
  });
}
export const parseJSON = (data: Buffer | string) => JSON.parse(data.toString());
