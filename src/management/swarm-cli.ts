import { readFile } from 'node:fs/promises';
import {
  deploySwarm,
  getSwarmStatus,
  cancelSwarm,
  listSwarmProfiles,
  type SwarmTask,
} from './swarm.js';

export async function runSwarmCli(args: string[]): Promise<void> {
  const subcommand = args[0] || 'help';

  switch (subcommand) {
    case 'profiles': {
      const profiles = await listSwarmProfiles();
      console.log('Available Swarm Profiles:');
      console.log('------------------------------------------------------------');
      for (const p of profiles) {
        const headroomStr = p.headroom !== null ? `${p.headroom.toFixed(1)}%` : 'unknown';
        const busyStr = p.busy ? '[BUSY]' : '[AVAILABLE]';
        const isolatedStr = p.isolated ? '(isolated)' : '(host)';
        console.log(
          `• ${p.label.padEnd(14)} [${p.tool}] ${busyStr.padEnd(12)} Headroom: ${headroomStr.padEnd(8)} ${p.account ?? 'no account'} ${isolatedStr}`,
        );
      }
      console.log('------------------------------------------------------------');
      break;
    }

    case 'run': {
      let provider: 'antigravity' | 'codex' | 'auto' = 'antigravity';
      let timeoutSeconds = 300;
      let isolateWorkspace = true;
      let jsonOutput = false;
      let tasksJsonFile: string | undefined;
      const tasks: SwarmTask[] = [];

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--provider' && args[i + 1]) {
          provider = args[++i] as any;
        } else if (arg === '--task' && args[i + 1]) {
          const taskStr = args[++i];
          tasks.push({
            id: `task-${tasks.length + 1}`,
            task: taskStr,
            isolate_workspace: isolateWorkspace,
          });
        } else if (arg === '--tasks' && args[i + 1]) {
          tasksJsonFile = args[++i];
        } else if (arg === '--timeout' && args[i + 1]) {
          timeoutSeconds = parseInt(args[++i], 10);
        } else if (arg === '--no-worktree') {
          isolateWorkspace = false;
        } else if (arg === '--json') {
          jsonOutput = true;
        }
      }

      if (tasksJsonFile) {
        const content = await readFile(tasksJsonFile, 'utf8');
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          for (let idx = 0; idx < parsed.length; idx++) {
            const item = parsed[idx];
            tasks.push({
              id: item.id ?? `task-${idx + 1}`,
              task: item.task ?? item.prompt,
              cwd: item.cwd,
              isolate_workspace: item.isolate_workspace ?? isolateWorkspace,
              model: item.model,
            });
          }
        }
      }

      if (!tasks.length) {
        console.error('Error: No tasks provided. Use --task "<prompt>" or --tasks <file.json>');
        process.exitCode = 1;
        return;
      }

      if (!jsonOutput) {
        console.log(
          `🚀 Deploying Principal Swarm (${provider}): ${tasks.length} tasks in parallel...`,
        );
      }

      const result = await deploySwarm({
        provider,
        tasks,
        wait_for_completion: true,
        timeout_seconds: timeoutSeconds,
      });

      if (jsonOutput) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n${result.summary}\n`);
        for (const worker of result.workers) {
          const statusIcon = worker.status === 'completed' ? '✔' : '✖';
          console.log(
            `${statusIcon} Task ${worker.id} (${worker.profileLabel} · ${worker.account ?? 'no account'}) [${worker.durationMs}ms] -> ${worker.status}`,
          );
          if (worker.gitDiff && worker.gitDiff.trim().length > 0) {
            console.log(`   Changes produced (${worker.modifiedFiles?.length ?? 0} files):`);
            const snippet = worker.gitDiff.split('\n').slice(0, 5).join('\n');
            console.log(`   ${snippet}\n   ...`);
          }
          if (worker.status !== 'completed' && worker.error) {
            console.log(`   Error: ${worker.error}`);
          }
        }
      }
      break;
    }

    case 'status': {
      const swarmId = args[1];
      if (!swarmId) {
        console.error('Usage: principal swarm status <swarm-id>');
        process.exitCode = 1;
        return;
      }
      const status = getSwarmStatus(swarmId);
      if (!status) {
        console.error(`Swarm '${swarmId}' not found or already completed.`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(status, null, 2));
      break;
    }

    case 'cancel': {
      const swarmId = args[1];
      if (!swarmId) {
        console.error('Usage: principal swarm cancel <swarm-id>');
        process.exitCode = 1;
        return;
      }
      const cancelled = await cancelSwarm(swarmId);
      console.log(cancelled ? `Swarm '${swarmId}' cancelled.` : `Swarm '${swarmId}' not found.`);
      break;
    }

    default:
      console.log(`Principal Swarm Orchestrator

Usage:
  principal swarm profiles                     List available profiles and quota headroom
  principal swarm run [options]                Deploy parallel worker agents
  principal swarm status <swarm-id>            Check status of a swarm
  principal swarm cancel <swarm-id>            Cancel a running swarm
  principal serve-mcp                          Start the Model Context Protocol stdio server

Options for 'principal swarm run':
  --provider <antigravity|codex|auto>          Target provider (default: antigravity)
  --task "<instruction>"                       Task instruction (repeatable for multiple tasks)
  --tasks <file.json>                          Path to JSON file containing array of tasks
  --timeout <seconds>                          Timeout per task (default: 300)
  --no-worktree                                Disable Git worktree isolation
  --json                                       Output complete result as JSON
`);
      break;
  }
}
