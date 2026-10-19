import { createServer } from 'node:net';
import { chmod, mkdtemp, rm, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { exec } from '../util.js';
import { managementPaths, privateDirectory } from './paths.js';
import { findExecutable } from './providers.js';
import { identityMatches } from './process.js';
import type { Invocation } from './model.js';
import type { LaunchOptions } from './launcher.js';

export const tmuxSocket = () => path.join(managementPaths.runtime, 'tmux.sock');
export async function attachment(invocation: Invocation) {
  const terminal = invocation.terminal;
  if (
    !terminal ||
    !invocation.owned ||
    !invocation.wrapper ||
    invocation.lifecycle === 'exited' ||
    terminal.socket !== tmuxSocket() ||
    !/^principal-[a-f0-9-]{36}$/.test(terminal.session) ||
    !(await identityMatches(invocation.wrapper))
  )
    return null;
  const binary = await findExecutable('tmux');
  if (!binary) return null;
  try {
    const meta = await lstat(terminal.socket);
    if (!meta.isSocket() || meta.uid !== process.getuid?.() || meta.mode & 0o077) return null;
    const pane = await exec(
      binary,
      ['-S', terminal.socket, 'display-message', '-p', '-t', terminal.session, '#{pane_pid}'],
      { timeout: 3000, maxBytes: 1024, allowFailure: true },
    );
    if (
      pane.code !== 0 ||
      Number(pane.stdout.toString().trim()) !== invocation.wrapper.pid ||
      !(await identityMatches(invocation.wrapper))
    )
      return null;
    return {
      executable: binary,
      args: ['-S', terminal.socket, 'attach-session', '-t', terminal.session],
      env: { ...process.env, TMUX: undefined },
    };
  } catch {
    return null;
  }
}

/** A private one-shot IPC handoff avoids putting credentials in tmux argv, files or server environment. */
export async function startMultiplexed(options: LaunchOptions) {
  const binary = await findExecutable('tmux');
  if (!binary)
    throw new Error('Install tmux for persistent native terminals, or choose Direct terminal.');
  await privateDirectory(managementPaths.runtime);
  const directory = await mkdtemp(path.join(managementPaths.runtime, 'terminal-'));
  const socket = path.join(directory, 'handoff.sock');
  const terminal: NonNullable<Invocation['terminal']> = {
    kind: 'tmux',
    socket: tmuxSocket(),
    session: 'principal-' + randomUUID(),
  };
  const clients = new Set<import('node:net').Socket>();
  let resolveReady!: (id: string) => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  const server = createServer((client) => {
    if (clients.size) {
      client.destroy();
      return;
    }
    clients.add(client);
    client.on('error', () => {});
    client.write(
      JSON.stringify({ options: { ...options, multiplex: false, terminal }, env: process.env }) +
        '\n',
    );
    let body = '';
    client.on('data', (data) => {
      body += data.toString();
      if (body.length > 4096) {
        client.destroy();
        return;
      }
      if (!body.includes('\n')) return;
      try {
        const result = JSON.parse(body);
        if (typeof result.id === 'string' && /^[a-f0-9-]{36}$/.test(result.id))
          resolveReady(result.id);
        else
          rejectReady(
            new Error('Persistent native launch failed. Check the profile and project directory.'),
          );
      } catch {
        rejectReady(new Error('Invalid persistent native launch acknowledgement'));
      }
    });
    client.on('close', () => clients.delete(client));
  });
  const timeout = setTimeout(
    () =>
      rejectReady(
        new Error(
          'Persistent launch acknowledgement timed out. Inspect /sessions before retrying; no running agent was stopped.',
        ),
      ),
    30_000,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    await chmod(socket, 0o600);
    const safeEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(PATH|HOME|USER|LOGNAME|LANG|LC_.*|TERM|SHELL)$/.test(key),
      ),
    );
    await exec(
      binary,
      [
        '-f',
        '/dev/null',
        '-S',
        terminal.socket,
        'new-session',
        '-d',
        '-s',
        terminal.session,
        '-c',
        options.directory ?? process.cwd(),
        '-x',
        String(process.stdout.columns ?? 100),
        '-y',
        String(process.stdout.rows ?? 30),
        process.execPath,
        fileURLToPath(new URL('./tmux-worker.js', import.meta.url)),
        socket,
      ],
      { env: safeEnv, timeout: 5000, maxBytes: 4096 },
    );
    return { id: await ready, terminal };
  } finally {
    clearTimeout(timeout);
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
