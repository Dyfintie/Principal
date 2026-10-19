#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { rpc } from './client.js';
import { ConfigSchema, validateGraph, type Config } from './schema.js';
import { usageLines } from './usage-view.js';
import { enrollAccount } from './account-enrollment.js';
import { nativeArguments } from './management/arguments.js';
import { Runtime } from './runtime.js';
import { exec, cleanText, redact } from './util.js';
import { ReadableLogs, readableStatus } from './presentation.js';
import { registerManagementCommands, managementDoctor } from './management/commands.js';
import { normalizeTool } from './management/model.js';
export interface TuiCommandBridge {
  directory: string;
  output: (text: string) => void;
  handoff: (operation: () => Promise<unknown>) => void;
}
/** Internal command routing. This is never exposed as a shell CLI. */
export async function executeTuiCommand(text: string, bridge: TuiCommandBridge) {
  const print = (value: unknown) =>
    bridge.output(
      cleanText(redact(typeof value === 'string' ? value : JSON.stringify(value, null, 2))),
    );
  const native = async (operation: () => Promise<unknown>) => {
    bridge.handoff(operation);
  };
  const program = new Command()
    .name('/command')
    .description('Manage native coding agents, profiles, sessions, and resources')
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeOut: (value) => print(value), writeErr: (value) => print(value) })
    .version('0.1.0')
    .option('--json', 'Emit versioned JSON')
    .option('--mode <mode>', 'Open principal or native mode', 'principal')
    .option('--pool <name>', 'Account pool for the initial interface')
    .option('--lead <account>', 'Account for the initial interface')
    .option('--repo <directory>', 'Project directory', bridge.directory)
    .option('--config <file>', 'Project configuration file');
  async function config(directory = bridge.directory): Promise<Config> {
    const file = program.opts().config
      ? path.resolve(program.opts().config)
      : path.join(directory, 'principal.config.json');
    try {
      return ConfigSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !program.opts().config)
        return ConfigSchema.parse({});
      throw e;
    }
  }
  function output(data: unknown) {
    print(data);
  }
  async function login(rawProvider: string, label: string, reauth = false) {
    if (!process.stdin.isTTY) throw new Error('Login requires an interactive terminal');
    const provider = normalizeTool(rawProvider) ?? rawProvider;
    if (provider !== 'codex' && provider !== 'antigravity')
      throw new Error('Choose codex (cdx) or antigravity (agy)');
    const c = await config();
    await native(() => enrollAccount(provider, { label, reauth, config: c }));
  }
  program
    .command('init')
    .description('Write a project configuration')
    .action(async () => {
      const file = path.resolve(bridge.directory, program.opts().config ?? 'principal.config.json');
      await writeFile(file, JSON.stringify(ConfigSchema.parse({}), null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      output({ created: file });
    });
  program
    .command('doctor')
    .description('Inspect local prerequisites without consuming inference quota')
    .option('--legacy', 'Inspect the optional orchestration/container runtime')
    .option('--json')
    .option('--check-inference', 'Explicitly consume a small amount of inference quota')
    .option('--account <label>')
    .action(async (options, command) => {
      if (!options.legacy && !options.checkInference)
        return managementDoctor(command, (_command, value) => print(value));
      const checks = [
        { name: 'node', available: true, detail: `${process.version} (${process.execPath})` },
      ];
      for (const [name, args] of [
        ['docker', ['info', '--format', '{{json .SecurityOptions}}']],
        ['git', ['--version']],
        ['secret-tool', ['--version']],
        ['ssh', ['-V']],
        ['flock', ['--version']],
      ] as [string, string[]][]) {
        try {
          const result = await exec(
            name === 'secret-tool' ? 'which' : name,
            name === 'secret-tool' ? [name] : args,
            { allowFailure: true },
          );
          checks.push({
            name,
            available: result.code === 0,
            detail: redact((result.stdout.toString() || result.stderr.toString()).trim()),
          });
        } catch (e) {
          checks.push({ name, available: false, detail: (e as Error).message });
        }
      }
      const c = await config();
      try {
        const image = await exec('docker', [
          'image',
          'inspect',
          c.runtime.image,
          '--format',
          '{{.Id}}',
        ]);
        checks.push({
          name: 'runtime image',
          available: true,
          detail: image.stdout.toString().trim(),
        });
      } catch {
        checks.push({
          name: 'runtime image',
          available: false,
          detail: 'Use /runtime build with installed provider binary paths inside Principal',
        });
      }
      let inference = null;
      if (options.checkInference) {
        if (!options.account) throw new Error('--check-inference requires --account');
        print('This check consumes the selected account’s inference allowance.');
        inference = await rpc('accounts.checkInference', { account: options.account, config: c });
      }
      output({
        platform: process.platform,
        node: process.version,
        checks,
        inferencePerformed: !!inference,
        inference,
      });
      if (checks.some((c) => !c.available)) print('Some prerequisites are unavailable.');
    });
  const runtime = program.command('runtime').description('Manage isolated provider runtime');
  runtime
    .command('build')
    .option('--codex <path>', 'Path to the installed Codex executable')
    .option('--antigravity <path>', 'Path to the installed agy executable')
    .option('--image <tag>')
    .action(async (options) => {
      if (program.opts().json) throw new Error('Runtime build is interactive; omit --json');
      const image = options.image ?? (await config()).runtime.image;
      await native(() => new Runtime().build({ ...options, image }));
    });
  const accounts = program.command('accounts');
  accounts
    .command('add <provider>')
    .requiredOption('--label <label>')
    .action(async (provider, options) => login(provider, options.label));
  accounts.command('list').action(async () => output(await rpc('accounts.list')));
  accounts.command('reauth <account>').action(async (label) => {
    const a = (await rpc('accounts.list')).find((a: any) => a.label === label || a.id === label);
    if (!a) throw new Error('Unknown account');
    await login(a.provider, a.label, true);
  });
  accounts
    .command('remove <account>')
    .action(async (account) =>
      output(await rpc('accounts.remove', { account, config: await config() })),
    );
  accounts
    .command('model <account> <model>')
    .description('Set the preferred model; entitlement is checked on use')
    .action(async (account, model) => output(await rpc('accounts.model', { account, model })));
  program
    .command('models')
    .requiredOption('--account <label>')
    .action(async (options) =>
      output(await rpc('models', { account: options.account, config: await config() })),
    );
  const pools = program.command('pools');
  pools
    .command('create <name>')
    .requiredOption('--accounts <labels>', 'Comma separated account labels')
    .action(async (name, options) =>
      output(await rpc('pools.create', { name, accounts: options.accounts.split(',') })),
    );
  pools.command('list').action(async () => output(await rpc('pools.list')));
  program
    .command('usage')
    .option('--pool <name>')
    .option('--refresh')
    .option('--json')
    .action(async (options) => {
      const result = await rpc('usage', {
        pool: options.pool,
        refresh: !!options.refresh,
        config: await config(),
      });
      if (options.json || program.opts().json) {
        print(JSON.stringify({ schemaVersion: 1, data: result }));
        return;
      }
      for (const line of usageLines(result, Math.max(20, (process.stdout.columns ?? 80) - 4)))
        print(line.text);
    });
  program
    .command('plan <goal>')
    .option('--pool <name>')
    .option('--account <label>', 'Supervisor account')
    .option('--out <file>', 'Write a reviewable task graph', 'plan.json')
    .action(async (goal, options) => {
      const c = await config();
      print('Planning uses the selected account’s inference allowance.');
      const graph = await rpc('plan', {
        goal,
        pool: options.pool ?? c.pool,
        account: options.account,
        repo: bridge.directory,
        config: c,
      });
      await writeFile(options.out, JSON.stringify(graph, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      output({ file: path.resolve(options.out), graph });
    });
  program
    .command('run [goal]')
    .option('--plan <file>')
    .option('--tasks <file>')
    .option('--pool <name>')
    .option('--supervisor <label>')
    .option('--allow-unknown-quota', 'Explicitly permit accounts with unreported quota')
    .option('--wait', 'Wait for a terminal run state')
    .action(async (goal, options) => {
      const c = await config();
      if (options.allowUnknownQuota) c.routing.allowUnknownQuota = true;
      let run;
      if (options.plan || options.tasks) {
        if (goal) throw new Error('Provide a goal or a task file');
        const graph = validateGraph(
          JSON.parse(await readFile(options.plan ?? options.tasks, 'utf8')),
        );
        run = await rpc('runs.create', { graph, repo: bridge.directory, config: c });
      } else {
        if (!goal) throw new Error('Provide --tasks, --plan, or a goal');
        print('Automatic planning uses inference allowance.');
        run = await rpc('runs.goal', {
          goal,
          pool: options.pool ?? c.pool,
          supervisor: options.supervisor,
          repo: bridge.directory,
          config: c,
        });
      }
      output({ id: run.id, status: run.status });
      if (options.wait) {
        output('Run admitted. Use /dashboard runs to watch it; this interface stays responsive.');
        return;
      }
    });
  program.command('status [id]').action(async (id) => {
    const value = await rpc(id ? 'runs.status' : 'runs.list', id ? { id } : {});
    if (id && !program.opts().json) {
      value.accountLabels = Object.fromEntries(
        (await rpc('accounts.list')).map((a: any) => [a.id, a.label]),
      );
    }
    output(program.opts().json ? value : readableStatus(value));
  });
  program
    .command('logs <id>')
    .option('--task <id>')
    .option('--follow')
    .option('--raw', 'Show every event, including token fragments and quota telemetry')
    .action(async (id, options) => {
      if (options.follow)
        throw new Error('Use /dashboard runs for live monitoring; /logs shows the current log.');
      let after = 0;
      const readable = new ReadableLogs((line) => print(line));
      do {
        const events = await rpc('runs.events', { id, after });
        for (const e of events) {
          after = Math.max(after, e.seq);
          if (options.task && e.taskId !== options.task) continue;
          if (program.opts().json) print(JSON.stringify({ schemaVersion: 1, ...e }));
          else if (options.raw)
            print(`${e.at} ${e.taskId ?? 'run'} ${e.type} ${cleanText(JSON.stringify(e.data))}`);
          else readable.event(e);
        }
        readable.flush();
      } while (options.follow);
    });
  for (const command of ['cancel', 'resume', 'apply', 'prune'])
    program
      .command(`${command} <id>`)
      .action(async (id) => output(await rpc(`runs.${command}`, { id })));
  program
    .command('integrate <id>')
    .option('--base <ref>', 'Reintegrate against a ref in the original repository')
    .action(async (id, options) => {
      let base = options.base;
      if (base) {
        const s = await rpc('runs.status', { id });
        base = (await exec('git', ['rev-parse', `${base}^{commit}`], { cwd: s.run.repo })).stdout
          .toString()
          .trim();
      }
      output(await rpc('runs.integrate', { id, base }));
    });
  program
    .command('review <id>')
    .option('--patch', 'Show the complete integration diff')
    .action(async (id, options) => {
      const result = await rpc('runs.review', { id });
      if (options.patch) {
        const s = result.run;
        if (!s.integration) throw new Error('No integration available');
        const diff = await exec('git', ['--no-pager', 'diff', '--no-ext-diff', s.base, 'HEAD'], {
          cwd: s.integration,
        });
        output(diff.stdout.toString());
      } else output(result);
    });
  const sessions = program.command('conversations').description('Manage Principal conversations');
  sessions.command('prune <id>').action(async (id) => output(await rpc('sessions.prune', { id })));
  sessions.command('list').action(async () => output(await rpc('sessions.list')));
  sessions
    .command('history <id>')
    .option('--after <cursor>', 'Message cursor', '0')
    .action(async (id, options) =>
      output(await rpc('sessions.history', { id, after: Number(options.after) })),
    );
  registerManagementCommands(program, {
    print: (_command, value) => print(value),
    runNative: native,
    directory: bridge.directory,
  });
  program.action(() => print(program.helpInformation()));
  const words = nativeArguments(text.replace(/^\//, ''));
  if (words[0] === 'tasks') words.shift();
  // The principal shell command is intentionally TUI-only. Operations are routed here.
  try {
    await program.parseAsync(words, { from: 'user' });
  } catch (error) {
    if (
      (error as { code?: string }).code === 'commander.helpDisplayed' ||
      (error as { code?: string }).code === 'commander.version'
    )
      return;
    throw error;
  }
}
