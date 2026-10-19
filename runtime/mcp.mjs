import { createInterface } from 'node:readline';
import { connect } from 'node:net';
const object = (properties) => ({
  type: 'object',
  properties,
  additionalProperties: false,
  required: Object.keys(properties),
});
const tools = [
  {
    name: 'submit_task_graph',
    description: 'Submit a bounded task DAG for coordinator validation',
    inputSchema: object({ graph: { type: 'object' } }),
  },
  {
    name: 'propose_task_revision',
    description: 'Propose additional tasks after reading worker results',
    inputSchema: object({ graph: { type: 'object' } }),
  },
  { name: 'list_task_status', description: 'List tasks in this run', inputSchema: object({}) },
  {
    name: 'read_task_result',
    description: 'Read a task summary and status',
    inputSchema: object({ taskId: { type: 'string' } }),
  },
  {
    name: 'read_artifact',
    description: 'Read a coordinator-validated task patch',
    inputSchema: object({ taskId: { type: 'string' }, kind: { type: 'string', enum: ['patch'] } }),
  },
  {
    name: 'cancel_task',
    description: 'Cancel a task belonging to this run',
    inputSchema: object({ taskId: { type: 'string' } }),
  },
];
function call(name, args) {
  return new Promise((resolve, reject) => {
    const socket = connect('/principal-bridge/bridge.sock');
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Coordinator tool timed out'));
    }, 30000);
    socket.on('connect', () => socket.end(JSON.stringify({ name, arguments: args })));
    socket.on('data', (b) => {
      data += b;
      if (data.length > 2 * 1024 * 1024) socket.destroy();
    });
    socket.on('error', reject);
    socket.on('close', () => {
      clearTimeout(timer);
      try {
        const p = JSON.parse(data);
        p.error ? reject(new Error(p.error)) : resolve(p.result);
      } catch (e) {
        reject(e);
      }
    });
  });
}
createInterface({ input: process.stdin }).on('line', async (line) => {
  let m;
  try {
    m = JSON.parse(line);
    if (m.id === undefined) return;
    let result;
    if (m.method === 'initialize')
      result = {
        protocolVersion: m.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'principal', version: '0.1.0' },
      };
    else if (m.method === 'ping') result = {};
    else if (m.method === 'tools/list') result = { tools };
    else if (m.method === 'tools/call') {
      try {
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify(await call(m.params.name, m.params.arguments ?? {})),
            },
          ],
        };
      } catch (e) {
        result = { isError: true, content: [{ type: 'text', text: e.message }] };
      }
    } else {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: m.id,
          error: { code: -32601, message: 'Unknown method' },
        }) + '\n',
      );
      return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
  } catch (e) {
    if (m?.id !== undefined)
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: e.message } }) +
          '\n',
      );
  }
});
