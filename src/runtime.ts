import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { readFile, writeFile, open, cp, mkdtemp, rm, realpath, stat, mkdir } from 'node:fs/promises';
import { tmpdir, totalmem, availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { exec, parseJSON, uid, sleep, interactive, paths } from './util.js';
import type { Account, Config } from './schema.js';
import { Locks } from './locks.js';
import { Vault } from './vault.js';
import { supportedVersions } from '../runtime/provider-versions.mjs';
export function nativeProtectedMounts(workspace: string, protectedRoots: string[], rejectProtectedArea = true, destinationRoot = '/workspace') {
  const relativeTo = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  for (const directory of protectedRoots)
    if (rejectProtectedArea && relativeTo(directory, workspace))
      throw new Error('Native mode cannot use Principal credential storage as its working directory');
  return [...new Set(protectedRoots)]
    .filter((directory) => relativeTo(workspace, directory))
    .map((directory) => {
      const destination = path.posix.join(destinationRoot, path.relative(workspace, directory));
      if (destination.includes(':')) throw new Error('Native protected mount paths cannot contain colons');
      return `${destination}:ro,nosuid,nodev,mode=000`;
    });
}
export function nativeWorkingDirectory(directory: string) {
  const reserved = ['/home/principal', '/opt/principal', '/run/principal', '/proc', '/sys', '/dev', '/usr/local/bin', '/tmp'];
  const overlaps = (left: string, right: string) => left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
  if (directory === '/' || reserved.some((root) => overlaps(directory, root))) {
    // Keep different projects distinct even when their host path shadows runtime storage.
    return '/native-workspaces/' + createHash('sha256').update(directory).digest('hex').slice(0, 24);
  }
  return directory;
}
export class Runtime {
  vault = new Vault();
  constructor(private commitGeneration?: (account: Account, generation: number) => void) {}
  private resourceLock = new Locks();
  async hasCapacity(memoryMiB: number) {
    const names = (
      await exec('docker', [
        'ps',
        '--filter',
        'label=principal.managed=true',
        '--format',
        '{{.Names}}',
      ])
    ).stdout
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
    let allocated = 0;
    if (names.length) {
      const output = (
        await exec('docker', ['inspect', '--format', '{{.HostConfig.Memory}}', ...names])
      ).stdout.toString();
      allocated = output
        .trim()
        .split('\n')
        .reduce((sum, value) => sum + Number(value), 0);
    }
    return allocated + memoryMiB * 1024 * 1024 <= totalmem() * 0.75;
  }
  async allocate<T>(memoryMiB: number, fn: () => Promise<T>) {
    return this.resourceLock.with('capacity', async () => {
      if (!(await this.hasCapacity(memoryMiB)))
        throw new Error(
          'Principal runtime memory budget is occupied; wait for existing work to finish',
        );
      return fn();
    });
  }
  private users = new Map<string, { uid: number; gid: number }>();
  async executionUser(login = false) {
    const security = (
      await exec('docker', ['info', '--format', '{{json .SecurityOptions}}'])
    ).stdout.toString();
    return {
      uid: !login && security.includes('rootless') ? 0 : process.getuid!(),
      gid: !login && security.includes('rootless') ? 0 : process.getgid!(),
    };
  }
  private async user(container: string) {
    const cached = this.users.get(container);
    if (cached) return cached;
    const data = parseJSON(
      (await exec('docker', ['inspect', container, '--format', '{{json .Config.Labels}}'])).stdout,
    );
    const user = {
      uid: Number(data['principal.uid'] ?? 1000),
      gid: Number(data['principal.gid'] ?? 1000),
    };
    this.users.set(container, user);
    return user;
  }
  async ensureNetwork() {
    return this.resourceLock.with('network', async () => {
      const network = 'principal-isolated';
      let inspected = await exec('docker', ['network', 'inspect', network], { allowFailure: true });
      if (inspected.code !== 0) {
        await exec('docker', [
          'network',
          'create',
          '--driver',
          'bridge',
          '--opt',
          'com.docker.network.bridge.enable_icc=false',
          network,
        ]);
        inspected = await exec('docker', ['network', 'inspect', network]);
      }
      const net = parseJSON(inspected.stdout)[0];
      if (
        net.Driver !== 'bridge' ||
        net.Options?.['com.docker.network.bridge.enable_icc'] !== 'false'
      )
        throw new Error(
          'Principal network must be a bridge with inter-container communication disabled',
        );
      return network;
    });
  }
  connectionArgs(config: Config) {
    const proxy =
      config.runtime.proxy ??
      process.env.HTTPS_PROXY ??
      process.env.https_proxy ??
      process.env.HTTP_PROXY ??
      process.env.http_proxy;
    return proxy
      ? [
          '--env',
          `HTTPS_PROXY=${proxy}`,
          '--env',
          `HTTP_PROXY=${proxy}`,
          '--env',
          'NO_PROXY=localhost,127.0.0.1,::1',
        ]
      : [];
  }
  async build(options: { codex?: string; antigravity?: string; image?: string } = {}) {
    if (process.getuid?.() === 0)
      throw new Error('Build Principal as your regular Linux user, not root');
    const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../runtime');
    const context = await mkdtemp(path.join(tmpdir(), 'principal-build-'));
    const manifest: {
      schemaVersion: number;
      providers: Record<string, unknown>;
      protocolReference: string;
    } = { schemaVersion: 1, providers: {}, protocolReference: 'codex-cli 0.160.1' };
    try {
      await mkdir(path.join(context, 'provider-bin'));
      await cp(source, path.join(context, 'runtime'), { recursive: true });
      await cp(path.join(source, 'Dockerfile'), path.join(context, 'Dockerfile'));
      for (const provider of ['codex', 'antigravity'] as const) {
        const name = provider === 'codex' ? 'codex' : 'agy';
        const location =
          options[provider] ?? (await exec('which', [name])).stdout.toString().trim();
        const actual = await realpath(location);
        if (!(await stat(actual)).isFile()) throw new Error(`${name}: expected executable file`);
        const version = (await exec(actual, ['--version'])).stdout.toString().trim();
        if (!supportedVersions[provider].includes(version.match(/\d+\.\d+\.\d+/)?.[0] ?? ''))
          throw new Error(
            `Unsupported ${provider} version ${version}; update and validate the adapter before rebuilding`,
          );
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(actual)) hash.update(chunk);
        manifest.providers[provider] = {
          version,
          sha256: hash.digest('hex'),
          liveValidated: false,
        };
        await cp(actual, path.join(context, 'provider-bin', name), { recursive: false });
        if (provider === 'codex') {
          const helper = path.join(path.dirname(actual), 'codex-code-mode-host');
          const info = await stat(helper).catch(() => null);
          if (!info?.isFile() || !(info.mode & 0o111))
            throw new Error(
              `Codex installation is incomplete: missing executable ${helper}. Use the complete standalone release.`,
            );
          const helperHash = createHash('sha256');
          for await (const chunk of createReadStream(helper)) helperHash.update(chunk);
          manifest.providers.codex = {
            ...(manifest.providers.codex as Record<string, unknown>),
            codeModeHost: { sha256: helperHash.digest('hex') },
          };
          await cp(helper, path.join(context, 'provider-bin', 'codex-code-mode-host'));
        }
      }
      await writeFile(
        path.join(context, 'runtime', 'compatibility.json'),
        JSON.stringify(manifest, null, 2) + '\n',
      );
      await interactive(
        'docker',
        [
          'build',
          '--build-arg',
          `PRINCIPAL_UID=${process.getuid!()}`,
          '--build-arg',
          `PRINCIPAL_GID=${process.getgid!()}`,
          '--build-arg',
          'http_proxy',
          '--build-arg',
          'https_proxy',
          '--build-arg',
          'HTTP_PROXY',
          '--build-arg',
          'HTTPS_PROXY',
          '--build-arg',
          'NO_PROXY',
          '--tag',
          options.image ?? 'principal-runtime:local',
          context,
        ],
        {
          ...process.env,
          http_proxy: process.env.http_proxy ?? process.env.HTTP_PROXY,
          https_proxy: process.env.https_proxy ?? process.env.HTTPS_PROXY,
        },
      );
    } finally {
      await rm(context, { recursive: true, force: true });
    }
  }
  async create(
    account: Account,
    config: Config,
    options: Parameters<Runtime['createUnlocked']>[2] = {},
  ) {
    return this.allocate(config.runtime.memoryMiB, () =>
      this.createUnlocked(account, config, options),
    );
  }
  private async createUnlocked(
    account: Account,
    config: Config,
    options: {
      name?: string;
      workspace?: string;
      readOnly?: boolean;
      runId?: string;
      attemptId?: string;
      login?: boolean;
      native?: boolean;
      bridge?: string;
    } = {},
  ) {
    const image = (
      await exec('docker', ['image', 'inspect', config.runtime.image, '--format', '{{.Id}}'])
    ).stdout
      .toString()
      .trim();
    const actor = await this.executionUser(!!options.login);
    const userString = `${actor.uid}:${actor.gid}`;
    const name = options.name ?? `principal-${uid()}`;
    const destination = options.native && options.workspace ? nativeWorkingDirectory(options.workspace) : '/workspace';
    const memory = Math.min(
      config.runtime.memoryMiB,
      Math.floor((totalmem() / 1024 / 1024) * 0.75),
    );
    const network = await this.ensureNetwork();
    const args = [
      'create',
      '--network',
      network,
      '--name',
      name,
      '--label',
      'principal.managed=true',
      '--label',
      `principal.uid=${actor.uid}`,
      '--label',
      `principal.gid=${actor.gid}`,
      '--user',
      userString,
      '--label',
      `principal.account=${account.id}`,
      '--label',
      `principal.attempt=${options.attemptId ?? ''}`,
      '--label',
      `principal.run=${options.runId ?? ''}`,
      '--memory',
      `${memory}m`,
      '--cpus',
      String(Math.min(config.runtime.cpus, availableParallelism())),
      '--pids-limit',
      String(config.runtime.pids),
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--tmpfs',
      `/home/principal:rw,nosuid,nodev,uid=${actor.uid},gid=${actor.gid},mode=0700,size=512m`,
      '--tmpfs',
      `/run/principal:rw,nosuid,nodev,uid=${actor.uid},gid=${actor.gid},mode=0700,size=128m`,
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,mode=1777,size=256m',
    ];
    if (options.workspace) {
      args.push('--read-only');
      if (options.workspace.includes(','))
        throw new Error('Workspace paths containing commas are unsupported by Docker mount syntax');
      args.push(
        '--mount',
        `type=bind,src=${options.workspace},dst=${destination}${options.readOnly ? ',readonly' : ''}`,
      );
    }
    if (options.workspace) {
      const protectedRoots = await Promise.all([paths.state, paths.config].map((directory) => realpath(directory)));
      for (const mount of nativeProtectedMounts(options.workspace, protectedRoots, !!options.native, destination))
        args.push('--tmpfs', mount);
    }
    // Read-only conversations may use ordinary folders with no .git directory.
    // Writable workers always use private Git workspaces and protect their index.
    if (options.workspace && !options.readOnly && !options.native)
      args.push('--mount', `type=bind,src=${options.workspace}/.git,dst=/workspace/.git,readonly`);
    if (options.bridge)
      args.push('--mount', `type=bind,src=${options.bridge},dst=/principal-bridge,readonly`);
    args.push(...this.connectionArgs(config));
    if (options.login)
      args.push(
        '--user',
        '0:0',
        '--cap-add',
        'SETUID',
        '--cap-add',
        'SETGID',
        '--cap-add',
        'SYS_CHROOT',
        '--cap-add',
        'DAC_OVERRIDE',
        '--cap-add',
        'CHOWN',
        '--cap-add',
        'AUDIT_WRITE',
        '--publish',
        '127.0.0.1::2222',
        '--entrypoint',
        '/opt/principal/login.sh',
      );
    args.push(image);
    await exec('docker', args);
    this.users.set(name, actor);
    try {
      await exec('docker', ['start', name]);
      await this.vault.withSnapshot(
        account.id,
        account.provider,
        account.generation,
        async (file) => {
          if (!file) return;
          const child = spawn(
            'docker',
            [
              'exec',
              '-i',
              '--user',
              userString,
              name,
              'tar',
              '--no-same-owner',
              '-xf',
              '-',
              '-C',
              '/home/principal',
            ],
            { stdio: ['pipe', 'ignore', 'pipe'] },
          );
          let error = '';
          child.stderr.on('data', (b) => {
            error = (error + b.toString()).slice(-8192);
          });
          const completed = new Promise<void>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code) =>
              code === 0 ? resolve() : reject(new Error(`Native home restore failed: ${error}`)),
            );
          });
          completed.catch(() => {});
          const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
          try {
            await pipeline(createReadStream(file), child.stdin);
            await completed;
          } finally {
            clearTimeout(timer);
            if (child.exitCode === null) child.kill('SIGKILL');
          }
        },
      );
      await exec('docker', ['exec', '--user', userString, name, 'touch', '/run/principal/ready']);
      for (let i = 0; i < 100; i++) {
        try {
          await exec('docker', ['exec', name, 'test', '-S', '/run/principal/helper.sock']);
          break;
        } catch {
          if (i === 99) throw new Error('Account runtime failed to start');
          await sleep(100);
        }
      }
      await this.call(name, {
        op: 'configure',
        native: !!options.native,
        provider: account.provider,
        permissions: config.permissions,
        workspaceWritable: !!options.workspace && !options.readOnly,
        supervisor: !!options.bridge,
      });
      return name;
    } catch (e) {
      await this.stop(name).catch(() => {});
      throw e;
    }
  }
  async call(container: string, message: unknown, timeout = 40000) {
    const user = await this.user(container);
    const result = await exec(
      'docker',
      [
        'exec',
        '-i',
        '--user',
        `${user.uid}:${user.gid}`,
        container,
        'node',
        '/opt/principal/client.mjs',
      ],
      { input: JSON.stringify(message), timeout },
    );
    const r = parseJSON(result.stdout);
    if (r.error) throw Object.assign(new Error(r.error), { providerError: r.providerError });
    return r.result;
  }
  async snapshot(account: Account, container: string) {
    const user = await this.user(container);
    const child = spawn(
      'docker',
      [
        'exec',
        '--user',
        `${user.uid}:${user.gid}`,
        container,
        'tar',
        '--exclude=.codex/log',
        '--exclude=.codex/logs',
        '--exclude=.gemini/antigravity-cli/log',
        '--exclude=.gemini/antigravity-cli/logs',
        '--exclude=.gemini/antigravity-cli/crashes',
        '-cf',
        '-',
        '-C',
        '/home/principal',
        '.codex',
        '.gemini',
        '.config',
        '.local/share/keyrings',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let error = '';
    child.stderr.on('data', (b) => {
      error = (error + b.toString()).slice(-8192);
    });
    const completed = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`Native home snapshot failed: ${error}`)),
      );
    });
    completed.catch(() => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000),
      previous = account.generation,
      next = previous + 1;
    try {
      if (!Number.isSafeInteger(next)) throw new Error('Invalid credential generation');
      await this.vault.saveStream(account.id, account.provider, next, child.stdout);
      await completed;
      this.commitGeneration?.(account, next);
      account.generation = next;
      await this.vault.discardGeneration(account.id, previous).catch(() => {});
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
  async saveSnapshot(account: Account, archive: Buffer) {
    const previous = account.generation;
    const next = previous + 1;
    if (!Number.isSafeInteger(next)) throw new Error('Invalid credential generation');
    // Write a new file first: failed DB commits leave the previous generation readable.
    await this.vault.save(account.id, account.provider, next, archive);
    this.commitGeneration?.(account, next);
    account.generation = next;
    await this.vault.discardGeneration(account.id, previous).catch(() => {});
  }
  async stop(container: string) {
    const result = await exec('docker', ['rm', '--force', container], { allowFailure: true });
    if (result.code !== 0 && !/No such (?:container|object)/i.test(result.stderr.toString()))
      throw new Error(`Unable to confirm runtime stop: ${result.stderr.toString()}`);
    this.users.delete(container);
  }
  async exists(container: string) {
    const result = await exec('docker', ['inspect', container, '--format', '{{.State.Running}}'], {
      allowFailure: true,
    });
    if (result.code !== 0) {
      if (/No such (?:container|object)/i.test(result.stderr.toString())) return false;
      throw new Error('Docker state is unavailable; account runtime cannot be assumed stopped');
    }
    return result.stdout.toString().trim() === 'true';
  }
  async managed() {
    const r = await exec('docker', [
      'ps',
      '-a',
      '--filter',
      'label=principal.managed=true',
      '--format',
      '{{.Names}}',
    ]);
    return r.stdout.toString().trim().split('\n').filter(Boolean);
  }
  async removeRun(runId: string) {
    const result = await exec('docker', [
      'ps',
      '-a',
      '--filter',
      'label=principal.managed=true',
      '--filter',
      `label=principal.run=${runId}`,
      '--format',
      '{{.Names}}',
    ]);
    for (const container of result.stdout.toString().split('\n').filter(Boolean))
      await this.stop(container);
  }
  async preserveNativeSettings(container: string) {
    const user = await this.user(container);
    await exec('docker', ['exec', '--user', `${user.uid}:${user.gid}`, container, 'node', '/opt/principal/native-settings.mjs']);
  }
  async interruptNative(container: string) {
    await exec('docker', ['exec', container, 'pkill', '-TERM', '-f', '^node /opt/principal/native-interface.mjs'], { allowFailure: true });
    for (let i = 0; i < 50; i++) {
      const running = await exec('docker', ['exec', container, 'pgrep', '-f', '^node /opt/principal/native-interface.mjs'], { allowFailure: true });
      if (running.code !== 0) return;
      await sleep(100);
    }
    throw new Error('Native interface did not stop; account lease retained');
  }
  async nativeInterface(container: string, provider: string, model: string | null, directory: string) {
    const user = await this.user(container);
    // Reopen the TTY: Docker changes descriptor blocking flags while attached.
    // Inheriting Ink's existing descriptors can block Node's event loop on return.
    const tty = await open(await realpath('/proc/self/fd/0'), 'r+');
    process.stdin.pause();
    try {
      const child = spawn('docker', ['exec', '-it', '--workdir', directory, '--user', `${user.uid}:${user.gid}`, '--env', `TERM=${process.env.TERM && process.env.TERM !== 'dumb' ? process.env.TERM : 'xterm-256color'}`, '--env', 'COLORTERM=truecolor', container, 'node', '/opt/principal/native-interface.mjs', provider, ...(model ? [model] : [])], { stdio: [tty.fd, tty.fd, tty.fd] });
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Native ${provider} exited ${code}`)));
      });
    } finally { await tty.close(); }
  }
  async loginAntigravity(container: string) {
    const dir = await mkdtemp(path.join(tmpdir(), 'principal-ssh-'));
    try {
      const key = path.join(dir, 'identity');
      await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
      const pub = await readFile(`${key}.pub`);
      await exec(
        'docker',
        ['exec', '-i', container, 'sh', '-c', 'cat > /run/principal/authorized_keys'],
        { input: pub },
      );
      const mapping = (await exec('docker', ['port', container, '2222/tcp'])).stdout
        .toString()
        .trim();
      const port = mapping.split(':').at(-1)!;
      const hostKey = (
        await exec('docker', ['exec', container, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'])
      ).stdout
        .toString()
        .trim()
        .split(' ')
        .slice(0, 2)
        .join(' ');
      const known = path.join(dir, 'known_hosts');
      await writeFile(known, `[127.0.0.1]:${port} ${hostKey}\n`, { mode: 0o600 });
      await interactive('ssh', [
        '-tt',
        '-p',
        port,
        '-i',
        key,
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'PasswordAuthentication=no',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        `UserKnownHostsFile=${known}`,
        'principal@127.0.0.1',
        '/opt/principal/login-command.sh',
      ]);
    } finally {
      await exec('docker', ['exec', container, 'rm', '-f', '/run/principal/authorized_keys']).catch(
        () => {},
      );
      await rm(dir, { recursive: true, force: true });
    }
  }
}
