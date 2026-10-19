import {
  deploySwarm,
  getSwarmStatus,
  cancelSwarm,
  listSwarmProfiles,
} from '../management/swarm.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, any>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

const MCP_TOOLS = [
  {
    name: 'principal_deploy_swarm',
    description:
      'Deploy a parallel swarm of isolated worker agents across available Antigravity or Codex accounts with automatic quota headroom balancing and Git worktree isolation.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: ['antigravity', 'codex', 'auto'],
          default: 'antigravity',
          description: 'Provider to dispatch tasks to',
        },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique task identifier (e.g. task-1)' },
              task: {
                type: 'string',
                description: 'Instruction, prompt, or objective for the worker agent',
              },
              cwd: { type: 'string', description: 'Working directory or repository root' },
              isolate_workspace: {
                type: 'boolean',
                default: true,
                description: 'Provision an ephemeral Git worktree so workers never collide on files',
              },
              model: {
                type: 'string',
                description: 'Model override (e.g. gemini-2.5-pro, gemini-2.5-flash)',
              },
            },
            required: ['task'],
          },
          description: 'List of parallel tasks for the swarm',
        },
        wait_for_completion: {
          type: 'boolean',
          default: true,
          description: 'Block and return completed diffs and outputs',
        },
        timeout_seconds: {
          type: 'number',
          default: 300,
          description: 'Timeout per task in seconds',
        },
        max_parallel: {
          type: 'number',
          description: 'Maximum parallel workers (defaults to total available accounts)',
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'principal_get_swarm_status',
    description:
      'Check the execution progress, worker diffs, and results of an existing swarm by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        swarm_id: { type: 'string', description: 'The swarm ID returned by principal_deploy_swarm' },
      },
      required: ['swarm_id'],
    },
  },
  {
    name: 'principal_cancel_swarm',
    description: 'Cancel a running swarm execution and terminate all active worker agents.',
    inputSchema: {
      type: 'object',
      properties: {
        swarm_id: { type: 'string', description: 'The swarm ID to cancel' },
      },
      required: ['swarm_id'],
    },
  },
  {
    name: 'principal_list_profiles',
    description:
      'Inspect available agent profiles, authentication states, and remaining weekly quota headroom across accounts before dispatching work.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

export async function handleMcpRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const { id, method, params } = req;

  // Handle notifications (no id)
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') {
      // Client confirmed initialized
      return null;
    }
    return null;
  }

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'principal-swarm',
              version: '0.1.0',
            },
          },
        };

      case 'ping':
        return {
          jsonrpc: '2.0',
          id,
          result: {},
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: MCP_TOOLS,
          },
        };

      case 'tools/call': {
        const toolName = params?.name;
        const args = params?.arguments ?? {};

        let toolOutput: any;
        switch (toolName) {
          case 'principal_deploy_swarm': {
            toolOutput = await deploySwarm(args);
            break;
          }
          case 'principal_get_swarm_status': {
            const status = getSwarmStatus(args.swarm_id);
            if (!status) {
              throw new Error(`Swarm '${args.swarm_id}' not found`);
            }
            toolOutput = status;
            break;
          }
          case 'principal_cancel_swarm': {
            const cancelled = await cancelSwarm(args.swarm_id);
            toolOutput = { swarm_id: args.swarm_id, cancelled };
            break;
          }
          case 'principal_list_profiles': {
            toolOutput = await listSwarmProfiles();
            break;
          }
          default:
            throw new Error(`Unknown tool: ${toolName}`);
        }

        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput, null, 2),
              },
            ],
            isError: false,
          },
        };
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        };
    }
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: (error as Error).message,
          },
        ],
        isError: true,
      },
    };
  }
}

export function startMcpStdioServer(): void {
  let buffer = '';
  let pending = Promise.resolve();

  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      pending = pending.then(async () => {
        try {
          const req: JsonRpcRequest = JSON.parse(trimmed);
          const res = await handleMcpRequest(req);
          if (res) {
            process.stdout.write(JSON.stringify(res) + '\n');
          }
        } catch (err) {
          console.error('MCP JSON parsing error:', (err as Error).message);
        }
      });
    }
  });

  process.stdin.on('end', async () => {
    if (buffer.trim()) {
      pending = pending.then(async () => {
        try {
          const req: JsonRpcRequest = JSON.parse(buffer.trim());
          const res = await handleMcpRequest(req);
          if (res) {
            process.stdout.write(JSON.stringify(res) + '\n');
          }
        } catch (err) {
          console.error('MCP JSON parsing error:', (err as Error).message);
        }
      });
    }
    await pending;
    process.exit(0);
  });

  process.stderr.write('Principal Swarm MCP server listening on stdio\n');
}
