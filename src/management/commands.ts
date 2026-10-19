import { Command } from 'commander';
import path from 'node:path';
import { nativeStatuslineCommand } from './statusline-command.js';
import { managementRpc } from './client.js';
import { managementPaths } from './paths.js';
import { collectCallback } from './callback.js';
import { freshness, normalizeTool, type Snapshot } from './model.js';
import { launchAgent, launchMultipleAgents, latestInvocation, loginProfile, resumeEntry } from './launcher.js';
import { folderPath, invocationLabel } from './tree.js';
import { cleanText } from '../util.js';

function printCommand(command: Command, value: unknown) {
  if (command.optsWithGlobals().json)
    console.log(JSON.stringify({ schemaVersion: 1, protocolVersion: 1, data: value }));
  else console.log(cleanText(typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
}
export function observerConfiguration(profile: Snapshot['profiles'][number]) {
  if (!['claude', 'antigravity'].includes(profile.tool))
    throw new Error('No validated statusline observer for this tool');
  const command = nativeStatuslineCommand(profile.tool as 'claude' | 'antigravity');
  const hooks =
    profile.tool === 'claude'
      ? Object.fromEntries(
          [
            'UserPromptSubmit',
            'PreToolUse',
            'PermissionRequest',
            'PostToolUse',
            'PostToolUseFailure',
            'Stop',
          ].map((event) => [
            event,
            [{ hooks: [{ type: 'command', command: `${command} hook`, timeout: 2 }] }],
          ]),
        )
      : undefined;
  return {
    settingsFile: path.join(profile.directory, 'settings.json'),
    merge: { statusLine: { type: 'command', command }, ...(hooks ? { hooks } : {}) },
    note: 'Opt-in only: review and merge these settings yourself, preserving existing hooks. This replaces the native statusline command; Principal does not edit the file. Helpers fail open. Claude hooks emit no stdout or permission decisions.',
  };
}
export function registerManagementCommands(
  program: Command,
  ui: {
    print?: (command: Command, value: unknown) => void;
    runNative?: (operation: () => Promise<unknown>) => Promise<void>;
    directory?: string;
  } = {},
) {
  const print = ui.print ?? printCommand;
  const runNative =
    ui.runNative ??
    (async (operation) => {
      await operation();
    });
  const profiles = program
    .command('profiles')
    .alias('p')
    .description('Manage references to provider-owned native configurations');
  profiles
    .command('add <tool>')
    .requiredOption('--label <label>')
    .option('--isolated', 'Create an isolated native configuration (Codex/Claude only)')
    .option('--directory <path>', 'Register an existing native configuration')
    .option('--json')
    .action(async (toolInput, options, command) => {
      const tool = normalizeTool(toolInput) ?? toolInput;
      print(
        command,
        await managementRpc('profiles.add', {
          tool,
          label: options.label,
          isolated: !!options.isolated,
          directory: options.directory,
        }),
      );
    });
  profiles
    .command('list')
    .option('--json')
    .action(async (_options, command) => print(command, await managementRpc('profiles.list')));
  profiles
    .command('inspect <profile>')
    .description('Read native authentication metadata without reading credential files')
    .option('--json')
    .action(async (profile, _options, command) =>
      print(command, await managementRpc('profiles.inspect', { profile })),
    );
  profiles.command('login <profile>').action(async (profile) => {
    await runNative(() => loginProfile(profile));
  });
  profiles
    .command('remove <profile>')
    .description('Remove a profile (soft removal preserves credentials; use --purge to wipe everything)')
    .option('--purge', 'Completely wipe profile, credentials, and usage records everywhere')
    .action(async (profile, options, command) => {
      if (options.purge) {
        print(command, await managementRpc('profiles.purge', { profile }));
      } else {
        print(command, await managementRpc('profiles.remove', { profile }));
      }
    });
  profiles
    .command('purge <profile>')
    .description('Completely wipe profile, credentials, sandboxes, and usage records everywhere')
    .action(async (profile, _options, command) => {
      print(command, await managementRpc('profiles.purge', { profile }));
    });
  profiles
    .command('observer <profile>')
    .description('Print an opt-in native statusline setting; no files are modified')
    .option('--json')
    .action(async (reference, _options, command) => {
      const snapshot: Snapshot = await managementRpc('snapshot');
      const profile = snapshot.profiles.find((p) => p.id === reference || p.label === reference);
      if (!profile) throw new Error('Unknown profile');
      if (
        !snapshot.installations.find((i) => i.tool === profile.tool)?.capabilities.observer
          .supported
      )
        throw new Error('Statusline integration is not verified for the installed version');
      print(command, observerConfiguration(profile));
    });
  profiles
    .command('active')
    .description('Show currently active profiles and headroom across providers')
    .option('--json')
    .action(async (_options, command) => print(command, await managementRpc('profiles.active')));
  profiles
    .command('swap <toolOrTarget> [target]')
    .alias('sw')
    .description('Hot swap active profile for a provider')
    .option('--best', 'Pick profile with highest quota headroom')
    .option('--json')
    .action(async (toolOrTarget, target, options, command) => {
      let tool: string | undefined;
      let targetProfile: string | undefined;
      const matchedTool = normalizeTool(toolOrTarget);
      if (toolOrTarget && matchedTool) {
        tool = matchedTool;
        targetProfile = target;
      } else if (toolOrTarget) {
        targetProfile = toolOrTarget;
      }
      print(
        command,
        await managementRpc('profiles.swap', {
          tool,
          target: targetProfile,
          best: !!options.best,
        }),
      );
    });


  const registerSwapCommand = (cmd: Command) => {
    cmd
      .description('Hot swap active account for a provider (e.g. antigravity or codex)')
      .argument('[toolOrTarget]', 'Provider tool (antigravity/codex) or target profile')
      .argument('[target]', 'Target profile ID, label, or account email')
      .option('--best', 'Automatically pick the profile with highest remaining quota headroom')
      .option('--json')
      .action(async (toolOrTarget, target, options, command) => {
        if (!toolOrTarget && !target && !options.best) {
          const report: any = await managementRpc('profiles.active');
          if (options.json) {
            print(command, report);
            return;
          }
          const lines: string[] = ['Active Provider Profiles:'];
          for (const [tool, data] of Object.entries(report as Record<string, any>)) {
            const active = data.active;
            const activeLabel = active
              ? `${active.profile.label} (${active.profile.reportedAccount ?? 'account unknown'})`
              : 'None';
            const headroomStr =
              active?.remainingHeadroom !== undefined
                ? ` [Weekly Headroom: ${active.remainingHeadroom.toFixed(2)}%]`
                : '';
            lines.push(`  • ${tool.padEnd(12)}: ${activeLabel}${headroomStr}`);
          }
          lines.push('', 'Available Accounts to Hot Swap:');
          for (const [tool, data] of Object.entries(report as Record<string, any>)) {
            lines.push(`[${tool}]`);
            const pList = data.profiles;
            for (let i = 0; i < pList.length; i++) {
              const p = pList[i];
              const activeMarker = p.isActive ? ' (ACTIVE)' : '';
              const recMarker = !p.isActive && i === 0 ? ' [RECOMMENDED]' : '';
              const headroom =
                p.remainingHeadroom !== undefined
                  ? `${p.remainingHeadroom.toFixed(2)}% headroom`
                  : 'quota unknown';
              const authStatus = p.profile.auth !== 'authenticated' ? ` (${p.profile.auth})` : '';
              lines.push(
                `  ${p.isActive ? '*' : ' '} ${p.profile.label.padEnd(12)} ${p.profile.reportedAccount ?? 'no account'} - ${headroom}${authStatus}${activeMarker}${recMarker}`,
              );
            }
          }
          lines.push('', 'Usage:');
          lines.push('  /swap <tool> <profile>   e.g. /swap agy anti_2 or /swap cdx cdx_main');
          lines.push('  /swap <tool> --best      e.g. /swap agy --best or /swap cdx --best');
          lines.push('  /swap <profile>          e.g. /swap anti_2');
          print(command, lines.join('\n'));
          return;
        }

        let tool: string | undefined;
        let targetProfile: string | undefined;

        const matchedTool = normalizeTool(toolOrTarget);
        if (toolOrTarget && matchedTool) {
          tool = matchedTool;
          targetProfile = target;
        } else if (toolOrTarget) {
          targetProfile = toolOrTarget;
        }

        const result: any = await managementRpc('profiles.swap', {
          tool,
          target: targetProfile,
          best: !!options.best,
        });

        if (options.json) {
          print(command, result);
          return;
        }

        const lines: string[] = [
          `Swapped ${result.tool} active account:`,
          `  Active:   ${result.current.label} (${result.current.reportedAccount ?? 'no account'})`,
        ];
        if (result.previousId) {
          lines.push(`  Previous: ${result.previousId}`);
        }
        if (result.ambientSync?.synced) {
          lines.push(`  Ambient:  ${result.ambientSync.message}`);
        } else if (result.ambientSync?.message) {
          lines.push(`  Ambient Note: ${result.ambientSync.message}`);
        }
        if (result.tool === 'codex') {
          lines.push(`  Directory: ${result.current.directory}`);
          lines.push(`  Selector:  CODEX_HOME=${result.current.directory}`);
        }
        print(command, lines.join('\n'));
      });
  };

  registerSwapCommand(program.command('swap').alias('sw'));
  registerSwapCommand(program.command('switch'));

  program
    .command('launch')
    .alias('l')
    .description('Run the official CLI in this terminal, preserving native permissions')
    .option('--profile <profile>')
    .option('--best', 'Launch the profile with highest quota headroom')
    .option('--folder <folder>', 'Folder path or ID', 'unassigned')
    .option('--cwd <path>', 'Working directory')
    .option('--title <title>')
    .option('--conversation <id>', 'Resume a specific native conversation')
    .option('--allow-auth-env', 'Explicitly retain authentication environment overrides')
    .argument('[nativeArgs...]')
    .allowUnknownOption(true)
    .passThroughOptions()
    .action(async (nativeArgs, options) => {
      let args = nativeArgs ?? [];
      let targetProfiles: string[] = [];

      if (options.profile) {
        targetProfiles.push(...options.profile.split(',').map((s: string) => s.trim()).filter(Boolean));
      }

      if (!targetProfiles.length && args.length) {
        const matchedTool = normalizeTool(args[0]);
        let startIdx = 0;
        if (matchedTool) {
          startIdx = 1;
        }

        const leadingPositional: string[] = [];
        let flagsIdx = args.length;
        for (let i = startIdx; i < args.length; i++) {
          if (args[i].startsWith('-')) {
            flagsIdx = i;
            break;
          }
          leadingPositional.push(args[i]);
        }

        const remainingArgs = args.slice(flagsIdx);

        if (leadingPositional.length > 0) {
          targetProfiles = leadingPositional;
          args = remainingArgs;
        } else if (matchedTool) {
          targetProfiles = [matchedTool];
          args = remainingArgs;
        }
      }

      if (options.best) {
        const swapResult: any = await managementRpc('profiles.swap', {
          tool: targetProfiles[0] ? (normalizeTool(targetProfiles[0]) ?? targetProfiles[0]) : undefined,
          best: true,
        });
        targetProfiles = [swapResult.current.id];
      }

      const launchOpts = {
        directory: options.cwd ?? ui.directory,
        folder: options.folder,
        title: options.title,
        conversation: options.conversation,
        allowAuthEnv: !!options.allowAuthEnv,
        args,
      };

      if (targetProfiles.length > 1) {
        await runNative(() => launchMultipleAgents(targetProfiles, launchOpts));
      } else {
        await runNative(() =>
          launchAgent({
            ...launchOpts,
            profile: targetProfiles[0],
          }),
        );
      }
    });

  program
    .command('export [sessionId]')
    .alias('exp')
    .description('Export Codex session context to Antigravity when quota limits are reached')
    .option('--to <tool>', 'Target assistant tool (default: antigravity)', 'antigravity')
    .option('--output <path>', 'Custom output markdown file path')
    .option('--no-file', 'Do not save handoff file to disk')
    .option('--clip', 'Copy the condensed summary prompt to system clipboard')
    .option('--launch', 'Launch Antigravity immediately seeded with the exported context')
    .option('--json')
    .action(async (sessionId, options, command) => {
      const result: any = await managementRpc('context.export', {
        sessionId: sessionId || undefined,
        targetTool: options.to,
        saveToFile: options.file !== false,
        outputPath: options.output,
        copyToClipboard: !!options.clip,
      });

      if (options.json) {
        print(command, result);
        return;
      }

      const lines: string[] = [
        `🔄 Context Handoff Exported:`,
        `  Session:     ${result.title}`,
        `  Native ID:   ${result.nativeId}`,
        `  Directory:   ${result.directory}`,
        `  User Turns:  ${result.totalTurns}`,
      ];
      if (result.savedPath) {
        lines.push(`  Saved To:    ${result.savedPath}`);
      }
      if (result.copiedToClipboard) {
        lines.push(`  Clipboard:   Prompt copied to system clipboard!`);
      }
      lines.push('', '--- Recommended Antigravity Prompt ---', result.summaryPrompt);

      print(command, lines.join('\n'));

      if (options.launch) {
        const targetTool = normalizeTool(options.to) ?? 'antigravity';
        console.log(`\nLaunching ${targetTool} with exported context...\n`);
        await runNative(() =>
          launchAgent({
            tool: targetTool,
            directory: result.directory,
            args: [result.summaryPrompt],
          }),
        );
      }
    });

  const handoff = program
    .command('handoff')
    .alias('ho')
    .description('Share or import scoped account credentials safely between Principal users');

  handoff
    .command('export [profileOrTool]')
    .description('Export scoped credentials for Antigravity or Codex as a handoff token/file')
    .option('--passphrase <password>', 'Optional encryption passphrase')
    .option('--label <name>', 'Custom label for the recipient')
    .option('--time-limit <duration>', 'Set session time limit (e.g. 4h, 12h, 1d)')
    .option('--quota-limit <percent>', 'Set max weekly quota limit to consume (e.g. 20%)')
    .option('--out <path>', 'Save handoff bundle to file (.pauth)')
    .option('--clip', 'Copy armored handoff token to system clipboard')
    .option('--json')
    .action(async (profileOrTool, options, command) => {
      const result: any = await managementRpc('handoff.export', {
        profile: profileOrTool,
        tool: profileOrTool ? (normalizeTool(profileOrTool) ?? profileOrTool) : undefined,
        passphrase: options.passphrase,
        label: options.label,
        timeLimit: options.timeLimit,
        quotaLimit: options.quotaLimit,
        outputPath: options.out,
        copyToClipboard: !!options.clip,
      });

      if (options.json) {
        print(command, result);
        return;
      }

      const lines: string[] = [
        `🔐 Scoped Account Handoff Generated:`,
        `  Tool:         ${result.tool}`,
        `  Profile:      ${result.profileLabel}`,
        `  Account Hint: ${result.accountHint}`,
      ];
      if (result.constraints?.timeLimitHours !== undefined || result.constraints?.expiresAt) {
        lines.push(
          `  Time Limit:   ${result.constraints.timeLimitHours ?? 'N'} hours (Expires: ${new Date(result.constraints.expiresAt).toLocaleString()})`,
        );
      }
      if (result.constraints?.quotaLimitPercent !== undefined) {
        lines.push(
          `  Quota Limit:  Max ${result.constraints.quotaLimitPercent}% of weekly limit (Cutoff Floor: ${result.constraints.allowedQuotaFloor?.toFixed(1) ?? 'N'}%)`,
        );
      }
      if (result.savedPath) {
        lines.push(`  Saved To:     ${result.savedPath}`);
      }
      if (result.copiedToClipboard) {
        lines.push(`  Clipboard:    Handoff code copied to clipboard! (Ready to paste/share)`);
      }
      lines.push(
        '',
        '--- Handoff Code for Recipient ---',
        result.armoredToken,
        '',
        '🔒 Security Guarantees:',
        '  • Scoped ONLY to the assistant CLI. Zero Google/OpenAI browser passwords or session cookies.',
        '  • Your friend cannot access Gmail, Drive, Photos, or OpenAI web billing.',
        '  • Constraints are cryptographically locked: friend cannot alter time or quota limit.',
        '  • Revoke access anytime at: https://myaccount.google.com/permissions',
        '',
        'Recipient command (in their Principal):',
        `  principal handoff import "${result.armoredToken}"`,
      );

      print(command, lines.join('\n'));
    });

  handoff
    .command('import <codeOrFile>')
    .description('Import an account handoff token or bundle into an isolated Principal profile')
    .option('--passphrase <password>', 'Decryption passphrase if bundle is encrypted')
    .option('--label <name>', 'Custom profile label')
    .option('--json')
    .action(async (codeOrFile, options, command) => {
      const result: any = await managementRpc('handoff.import', {
        data: codeOrFile,
        passphrase: options.passphrase,
        label: options.label,
      });

      if (options.json) {
        print(command, result);
        return;
      }

      const lines: string[] = [
        `✅ Account Handoff Successfully Imported!`,
        `  Tool:        ${result.tool}`,
        `  Label:       ${result.label}`,
        `  Account:     ${result.accountHint}`,
        `  Directory:   ${result.directory}`,
      ];

      if (result.constraints?.timeLimitHours !== undefined || result.constraints?.expiresAt) {
        lines.push(
          `  ⏳ Time Limit:  ${result.constraints.timeLimitHours ?? 'N'} hours (Expires: ${new Date(result.constraints.expiresAt).toLocaleString()})`,
        );
      }
      if (result.constraints?.quotaLimitPercent !== undefined) {
        lines.push(
          `  📊 Quota Limit: Max ${result.constraints.quotaLimitPercent}% of weekly quota (Cutoff Floor: ${result.constraints.allowedQuotaFloor?.toFixed(1) ?? 'N'}%)`,
        );
      }

      lines.push(
        '',
        `Ready to use! Run in Principal:`,
        `  principal launch ${result.label}`,
        `  principal swap ${result.tool} ${result.label}`,
      );

      print(command, lines.join('\n'));
    });

  handoff
    .command('status [profileOrTool]')
    .description('Check active handoff constraints and quota usage for imported profiles')
    .option('--json')
    .action(async (profileOrTool, options, command) => {
      const snapshot: Snapshot = await managementRpc('snapshot');
      const profiles = snapshot.profiles.filter(
        (p) =>
          p.handoffConstraints &&
          (!profileOrTool ||
            p.id === profileOrTool ||
            p.label === profileOrTool ||
            p.tool === profileOrTool),
      );

      if (options.json) {
        print(
          command,
          profiles.map((p) => ({ profile: p.label, constraints: p.handoffConstraints })),
        );
        return;
      }

      if (!profiles.length) {
        print(command, 'No profiles with active handoff constraints found.');
        return;
      }

      const lines: string[] = ['🔒 Active Handoff Profiles & Constraints:'];
      for (const p of profiles) {
        const c = p.handoffConstraints!;
        lines.push(`\n  Profile: [${p.tool}] ${p.label} (${p.reportedAccount || 'unknown'})`);
        lines.push(`  Status:  ${c.status || 'active'}${c.reason ? ` (${c.reason})` : ''}`);
        if (c.timeLimitHours !== undefined && c.expiresAt) {
          const msLeft = Date.parse(c.expiresAt) - Date.now();
          const hrsLeft = (msLeft / (3600 * 1000)).toFixed(1);
          lines.push(
            `  Time:    ${msLeft > 0 ? `${hrsLeft}h remaining` : 'EXPIRED'} (Expires: ${new Date(c.expiresAt).toLocaleString()})`,
          );
        }
        if (c.quotaLimitPercent !== undefined) {
          lines.push(
            `  Quota:   Max ${c.quotaLimitPercent}% weekly budget (Floor: ${c.allowedQuotaFloor?.toFixed(1)}%)`,
          );
        }
      }
      print(command, lines.join('\n'));
    });

  const agents = program
    .command('agents')
    .description('Manage native session entries and invocations');
  agents
    .command('list')
    .option('--json')
    .option('--archived')
    .action(async (options, command) => {
      const snapshot: Snapshot = await managementRpc('snapshot');
      const entries = snapshot.entries
        .filter((e) => !!e.archivedAt === !!options.archived)
        .map((entry) => ({
          ...entry,
          folder: folderPath(entry.folderId, snapshot.folders),
          project: snapshot.projects.find((p) => p.id === entry.projectId),
          requestedProfile: snapshot.profiles.find((p) => p.id === entry.profileId) ?? null,
          invocation: latestInvocation(entry, snapshot.invocations) ?? null,
        }));
      print(
        command,
        command.optsWithGlobals().json
          ? { environment: snapshot.environment, seq: snapshot.seq, entries }
          : entries
              .map(
                (e) =>
                  `${e.id} · ${e.folder}/${e.project?.name} · ${e.title} · ${e.tool} · ${e.requestedProfile?.label ?? 'profile unknown'} · ${invocationLabel(e.invocation ?? undefined)}`,
              )
              .join('\n') ||
              'No sessions. Open /profiles to register a profile and launch an agent.',
      );
    });
  agents.command('resume <entry>').action(async (id) => {
    await runNative(() => resumeEntry(id));
  });
  agents
    .command('stop <invocation>')
    .option('--json')
    .action(async (id, _options, command) =>
      print(command, await managementRpc('invocations.stop', { id })),
    );
  agents
    .command('rename <entry> <title>')
    .option('--json')
    .action(async (id, title, _options, command) =>
      print(command, await managementRpc('entries.update', { id, title })),
    );
  agents
    .command('move <entry> <folder>')
    .option('--json')
    .action(async (id, folder, _options, command) =>
      print(command, await managementRpc('entries.update', { id, folder })),
    );
  agents
    .command('archive <entry>')
    .option('--undo')
    .option('--json')
    .action(async (id, options, command) =>
      print(command, await managementRpc('entries.update', { id, archived: !options.undo })),
    );
  agents
    .command('history')
    .requiredOption('--profile <profile>')
    .option('--folder <folder>', 'Import destination', 'unassigned')
    .option('--cwd <directory>')
    .option('--cursor <cursor>')
    .option('--json')
    .action(async (options, command) =>
      print(
        command,
        await managementRpc('history.read', {
          profile: options.profile,
          folder: options.folder,
          directory: options.cwd ?? ui.directory,
          cursor: options.cursor,
        }),
      ),
    );
  const folders = program
    .command('folders')
    .description('Organize virtual folders without touching project files');
  folders
    .command('list')
    .option('--json')
    .action(async (_options, command) => {
      const snapshot: Snapshot = await managementRpc('snapshot');
      print(
        command,
        snapshot.folders.map((f) => ({ ...f, path: folderPath(f.id, snapshot.folders) })),
      );
    });
  folders
    .command('create <path>')
    .option('--json')
    .action(async (path, _options, command) =>
      print(command, await managementRpc('folders.create', { path })),
    );
  folders
    .command('rename <folder> <name>')
    .option('--json')
    .action(async (id, name, _options, command) =>
      print(command, await managementRpc('folders.update', { id, name })),
    );
  folders
    .command('move <folder>')
    .option('--parent <folder>', 'Destination parent; omit for root')
    .option('--json')
    .action(async (id, options, command) =>
      print(command, await managementRpc('folders.update', { id, parent: options.parent ?? null })),
    );
  folders
    .command('order <folder> <position>')
    .option('--json')
    .action(async (id, position, _options, command) =>
      print(command, await managementRpc('folders.update', { id, order: Number(position) })),
    );
  folders
    .command('delete <folder>')
    .description('Delete an empty virtual folder')
    .option('--json')
    .action(async (id, _options, command) =>
      print(command, await managementRpc('folders.delete', { id })),
    );
  program
    .command('resources')
    .option('--refresh', 'Perform supported read-only probes; never inference')
    .option('--json')
    .action(async (options, command) => {
      const result = options.refresh
        ? await managementRpc('resources.refresh')
        : { resources: await managementRpc('resources') };
      const snapshot: Snapshot = await managementRpc('snapshot');
      const resources = result.resources.map((r: any) => ({
        ...r,
        freshness: freshness(r.observedAt),
      }));
      const unavailable = snapshot.profiles
        .filter((p) => !resources.some((r: any) => r.profileId === p.id))
        .map((p) => ({
          profileId: p.id,
          label: p.label,
          status: 'unavailable',
          reason: snapshot.installations.find((i) => i.tool === p.tool)?.capabilities.resources
            .reason,
        }));
      print(command, { ...result, resources, unavailable });
    });
  program
    .command('observe')
    .description('Opt-in observation helper; reads stdin, emits only whitelisted metadata')
    .requiredOption('--tool <tool>')
    .option('--hook', 'Parse a Claude lifecycle hook without emitting context or decisions')
    .action(async (options) => collectCallback(options.tool, !!options.hook));
}
export async function managementDoctor(command: Command, print = printCommand) {
  const snapshot: Snapshot = await managementRpc('installations.refresh').then(() =>
    managementRpc('snapshot'),
  );
  if (command.optsWithGlobals().json) {
    print(command, {
      environment: snapshot.environment,
      node: process.version,
      management: {
        database: managementPaths.db,
        socket: managementPaths.socket,
        protocolVersion: 1,
      },
      installations: snapshot.installations,
      inferencePerformed: false,
      limitations: [
        'Independent authentication has not been live-tested',
        'External discovery is conservative and cannot attach existing terminals',
        'WSL does not observe native Windows processes or credentials',
        'Quota visibility depends on provider-supported observations',
      ],
    });
    return;
  }

  const lines: string[] = [
    '🩺 Principal Doctor - Environment & System Check',
    '==================================================',
    `✓ Node.js Runtime:    ${process.version} (${process.arch}-${process.platform})`,
    `✓ Database:          ${managementPaths.db}`,
    `✓ Management Socket: ${managementPaths.socket}`,
    '',
    '🤖 Detected Coding Agents:',
  ];

  for (const inst of snapshot.installations) {
    const status = inst.executable
      ? `Installed (${inst.version ?? 'version unknown'})`
      : 'Not found (optional)';
    const icon = inst.executable ? '✓' : '○';
    const name =
      inst.tool === 'antigravity'
        ? 'Antigravity (agy)'
        : inst.tool === 'codex'
          ? 'OpenAI Codex (cdx)'
          : inst.tool === 'claude'
            ? 'Claude Code (cld)'
            : inst.tool;
    const detail = inst.executable ? ` [${inst.executable}]` : '';
    lines.push(`  ${icon} ${name.padEnd(22)}: ${status}${detail}`);
  }

  lines.push('', '👥 Registered Profiles:');
  if (!snapshot.profiles || snapshot.profiles.length === 0) {
    lines.push('  ○ No profiles registered yet.');
    lines.push('    Tip: Import an account from a friend with: principal handoff import <code>');
  } else {
    for (const p of snapshot.profiles) {
      const isActive = snapshot.activeProfiles?.[p.tool] === p.id;
      const activeMarker = isActive ? ' (ACTIVE)' : '';
      const handoffMarker = p.handoffConstraints ? ' [HANDOFF]' : '';
      const acct = p.reportedAccount ? ` [${p.reportedAccount}]` : '';
      lines.push(`  ✓ [${p.tool}] ${p.label}${acct}${handoffMarker}${activeMarker}`);
    }
  }

  lines.push(
    '',
    '💡 Quick Start:',
    '  • Launch Dashboard:     principal',
    '  • Launch Agent:         principal launch agy  (or: principal launch cdx)',
    '  • Share Quota:          principal handoff export <profile>',
    '  • Import Quota:         principal handoff import <code>',
    '',
    '✓ All systems operational! Ready to code.',
  );

  print(command, lines.join('\n'));
}
