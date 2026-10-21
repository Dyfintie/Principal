import { z } from 'zod';
import { managementRpc } from '../management/client.js';
import { redact } from '../util.js';
import { WorkerStart, WorkerControl, WorkerGet, WorkerMessage, WorkerArtifact } from '../management/worker-model.js';
import { SwarmDeploySchema } from '../management/swarm-model.js';

interface JsonRpcRequest { jsonrpc: '2.0'; id?: number | string | null; method: string; params?: Record<string, any> }
interface JsonRpcResponse { jsonrpc: '2.0'; id: number | string | null; result?: any; error?: { code: number; message: string } }
const empty = z.object({}).strict();
const swarmId = z.object({ swarm_id: z.string().uuid() }).strict();
const definitions = [
  ['principal_list_profiles', 'workers.profiles', 'Inspect exact profile IDs, native worker capabilities, quota provenance, reservations, and recent execution outcomes. Principal does not choose accounts.', empty],
  ['principal_start_worker', 'workers.start', 'Start an asynchronous persistent worker on the exact profile_id chosen by the lead. Retains its isolated Git worktree until explicitly released; request_id deduplicates delivery.', WorkerStart],
  ['principal_list_workers', 'workers.list', 'List durable workers across MCP connections, including stopped workers with retained workspaces.', empty],
  ['principal_get_worker', 'workers.get', 'Inspect worker/turn state, inactivity, diagnostics, artifacts, and a bounded event page. Pass nextCursor as cursor; wait_seconds is at most 25. Cancelling this wait does not stop execution.', WorkerGet],
  ['principal_send_worker_message', 'workers.message', 'Send a follow-up. auto steers Codex while busy (requires expected_turn_id) and queues Antigravity/Copilot; next_turn always queues. Explicit steer never silently falls back.', WorkerMessage],
  ['principal_cancel_worker', 'workers.cancel', 'Request interruption and shutdown of this worker, pause queued messages, and retain partial changes. Inspect state until cleanup completes; this does not release its workspace.', WorkerControl],
  ['principal_resume_worker', 'workers.resume', 'Explicitly restart a stopped worker on its original profile and native conversation, reacquiring the profile reservation. Pending messages remain paused until a new follow-up explicitly resumes them.', WorkerControl],
  ['principal_read_worker_artifact', 'workers.artifact', 'Read an immutable per-turn patch or metadata artifact in bounded base64 byte chunks. Offset is a byte offset; preserve bytes when concatenating chunks.', WorkerArtifact],
  ['principal_release_worker', 'workers.release', 'After stopping a worker, capture its final patch and delete only its owned worktree. Durable summaries, patches, and event journals remain available.', WorkerControl],
  ['principal_deploy_swarm', 'workers.swarm.deploy', 'Start a small explicit batch: every task requires a different profile_id and cwd. Asynchronous only; no automatic routing, retries, substitution, or hidden account queues.', SwarmDeploySchema],
  ['principal_get_swarm_status', 'workers.swarm.status', 'Read durable status and artifact references for an explicitly assigned batch across MCP connections.', swarmId],
  ['principal_cancel_swarm', 'workers.swarm.cancel', 'Request cancellation of every worker in this explicit batch; preserve workspaces and report per-worker cancellation errors.', swarmId.extend({ request_id: z.string().min(1).max(160) })],
] as const;

export const MCP_TOOLS = definitions.map(([name, , description, schema]) => ({
  name, description, inputSchema: z.toJSONSchema(schema, { target: 'draft-7' }),
}));
type Dispatch = (method: string, params?: unknown, signal?: AbortSignal) => Promise<any>;
const managementDispatch: Dispatch = (method, params, signal) => managementRpc(method, params, 35_000, signal);

export async function handleMcpRequest(req: JsonRpcRequest, dispatch: Dispatch = managementDispatch, signal?: AbortSignal): Promise<JsonRpcResponse | null> {
  const { id, method, params } = req;
  if (id === undefined || id === null) return null;
  try {
    switch (method) {
      case 'initialize': return { jsonrpc: '2.0', id, result: { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(params?.protocolVersion) ? params!.protocolVersion : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'principal-swarm', version: '0.2.0' } } };
      case 'ping': return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
      case 'tools/call': {
        const definition = definitions.find(([name]) => name === params?.name);
        if (!definition) throw new Error(`Unknown tool: ${params?.name}`);
        const args = definition[3].parse(params?.arguments ?? {});
        const result = await dispatch(definition[1], args, signal);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result ?? null) }], isError: false } };
      }
      default: return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  } catch (error) {
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: redact((error as Error).message) }], isError: true } };
  }
}

export function startMcpStdioServer(dispatch: Dispatch = managementDispatch): void {
  let buffer = '';
  const active = new Map<string | number, { controller: AbortController; promise: Promise<void> }>();
  const send = (response: JsonRpcResponse) => process.stdout.write(JSON.stringify(response) + '\n');
  const line = (text: string) => {
    if (!text.trim()) return;
    let request: JsonRpcRequest;
    try { request = JSON.parse(text); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || request.id !== undefined && request.id !== null && !['string', 'number'].includes(typeof request.id)) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); return;
    }
    if (request.method === 'notifications/cancelled') {
      active.get(request.params?.requestId)?.controller.abort(); return;
    }
    if (request.id === undefined || request.id === null) return;
    if (active.has(request.id)) { send({ jsonrpc: '2.0', id: request.id, error: { code: -32600, message: 'Request ID is already active' } }); return; }
    if (active.size >= 64) { send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Too many concurrent requests' } }); return; }
    const controller = new AbortController();
    const id = request.id;
    // Each request advances independently; a wait never blocks status/cancellation.
    const promise = handleMcpRequest(request, dispatch, controller.signal).then((response) => { if (response && !controller.signal.aborted) send(response); }).finally(() => active.delete(id));
    active.set(id, { controller, promise });
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
    for (const value of lines) {
      if (Buffer.byteLength(value) > 128 * 1024) send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request exceeds limit' } });
      else line(value);
    }
    if (Buffer.byteLength(buffer) > 128 * 1024) { buffer = ''; send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request exceeds limit' } }); }
  });
  process.stdin.on('end', () => {
    if (buffer.trim()) line(buffer);
    // Management and detached runners own execution; EOF does not cancel them.
    void Promise.allSettled([...active.values()].map((r) => r.promise));
  });
  process.stderr.write('Principal worker MCP server listening on stdio\n');
}
