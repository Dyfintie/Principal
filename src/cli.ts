#!/usr/bin/env node
import { managementDashboard } from './management/dashboard.js';
import { redact } from './util.js';

try {
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('Principal requires Node 24+.');
  const args = process.argv.slice(2);
  if (args[0] === 'serve-mcp' || args[0] === 'mcp') {
    const { startMcpStdioServer } = await import('./mcp/server.js');
    startMcpStdioServer();
  } else if (args[0] === 'swarm') {
    const { runSwarmCli } = await import('./management/swarm-cli.js');
    await runSwarmCli(args.slice(1));
  } else if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(
      'Principal · Interactive Terminal & Web Account & Quota Manager\n\n' +
      'Quick Start:\n' +
      '  principal                          Open interactive TUI dashboard\n' +
      '  principal web / dashboard          Open browser-based graphical management dashboard\n' +
      '  principal launch [tool|profile]    Launch an AI agent (agy, codex, claude)\n' +
      '  principal handoff export [profile] Export scoped account credentials with limits\n' +
      '  principal handoff import <code>    Import account credentials from a friend\n' +
      '  principal setup / doctor           Validate your installation and detected AI tools\n\n' +
      'Inside the TUI:\n' +
      '  /launch · /swap · /usage · /sessions · /accounts · /help',
    );
  } else if (args.length === 1 && ['--version', '-V'].includes(args[0])) {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(pkg.version || '0.1.2');
  } else if (['web', 'ui'].includes(args[0])) {
    const { startWebCommand } = await import('./management/web-server.js');
    await startWebCommand(args.slice(1));
  } else if (['doctor', 'setup'].includes(args[0])) {
    const { Command } = await import('commander');
    const { managementDoctor } = await import('./management/commands.js');
    const command = new Command().option('--json').exitOverride();
    try {
      await command.parseAsync(args.slice(1), { from: 'user' });
      await managementDoctor(command);
    } catch (err: any) {
      if (err?.code === 'commander.helpDisplayed') {
        process.exitCode = 0;
      } else {
        throw err;
      }
    }
  } else if (['launch', 'l', 'export', 'exp', 'handoff', 'ho'].includes(args[0])) {
    const { Command } = await import('commander');
    const { registerManagementCommands } = await import('./management/commands.js');
    const command = new Command()
      .enablePositionalOptions()
      .exitOverride();
    registerManagementCommands(command, {
      directory: process.cwd(),
      print: (_cmd, value) =>
        console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
      runNative: async (run) => {
        const code = await run();
        if (typeof code === 'number') process.exitCode = code;
      },
    });
    try {
      await command.parseAsync(args, { from: 'user' });
    } catch (err: any) {
      if (err?.code === 'commander.helpDisplayed') {
        process.exitCode = 0;
      } else {
        throw err;
      }
    }
  } else {
    if (args.length)
      throw new Error(
        'Principal is TUI-only. Run principal, then use /help for commands inside the application.',
      );
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error('Principal requires an interactive terminal.');
    await managementDashboard();
  }
} catch (error) {
  console.error(redact((error as Error).message));
  process.exitCode = 1;
}
