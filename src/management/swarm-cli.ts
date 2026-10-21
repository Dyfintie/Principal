import { readFile } from 'node:fs/promises';
import { managementRpc } from './client.js';
import { sleep } from '../util.js';

const help = `Principal controlled workers (0.2.0)

  principal swarm profiles
  principal swarm workers
  principal swarm start --json-file worker.json
  principal swarm get WORKER_ID [--cursor BYTES] [--wait SECONDS]
  principal swarm message --json-file message.json
  principal swarm cancel-worker WORKER_ID --request-id ID
  principal swarm resume WORKER_ID --request-id ID
  principal swarm artifact WORKER_ID ARTIFACT_ID [--offset BYTES]
  principal swarm release WORKER_ID --request-id ID
  principal swarm run --tasks batch.json --request-id ID [--wait]
  principal swarm status SWARM_ID
  principal swarm cancel SWARM_ID --request-id ID

start JSON requires request_id, profile_id, cwd, task; model/effort/timeout_seconds are optional.
message JSON requires request_id, worker_id, message; delivery defaults to auto.
batch.json is an array of tasks with explicit profile_id and cwd. Automatic routing is removed.
All execution mutations require a stable request ID. Output is JSON; artifact data is base64.
--wait polls from the CLI; closing the CLI leaves workers running. Stop/release explicitly.
`;

export async function runSwarmCli(args: string[]): Promise<void> {
  const command = args[0] ?? 'help';
  const flag = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const required = (value: string | undefined, name: string) => { if (!value) throw new Error(`Missing ${name}; run principal swarm help`); return value; };
  const requestId = () => required(flag('--request-id'), '--request-id');
  const json = async () => JSON.parse(await readFile(required(flag('--json-file'), '--json-file'), 'utf8'));
  let result: any;
  switch (command) {
    case 'profiles': result = await managementRpc('workers.profiles'); break;
    case 'workers': result = await managementRpc('workers.list'); break;
    case 'start': result = await managementRpc('workers.start', await json()); break;
    case 'message': result = await managementRpc('workers.message', await json()); break;
    case 'get': result = await managementRpc('workers.get', { worker_id: required(args[1], 'WORKER_ID'), cursor: Number(flag('--cursor') ?? 0), wait_seconds: Number(flag('--wait') ?? 0) }); break;
    case 'cancel-worker':
    case 'resume':
    case 'release': result = await managementRpc(`workers.${command === 'cancel-worker' ? 'cancel' : command}`, { worker_id: required(args[1], 'WORKER_ID'), request_id: requestId() }); break;
    case 'artifact': result = await managementRpc('workers.artifact', { worker_id: required(args[1], 'WORKER_ID'), artifact_id: required(args[2], 'ARTIFACT_ID'), offset: Number(flag('--offset') ?? 0) }); break;
    case 'run': {
      const tasks = JSON.parse(await readFile(required(flag('--tasks'), '--tasks'), 'utf8'));
      result = await managementRpc('workers.swarm.deploy', { request_id: requestId(), tasks, ...(flag('--timeout') ? { timeout_seconds: Number(flag('--timeout')) } : {}) });
      if (args.includes('--wait')) {
        while (result.status === 'running') {
          await sleep(1000); result = await managementRpc('workers.swarm.status', { swarm_id: result.swarmId });
        }
      }
      break;
    }
    case 'status': result = await managementRpc('workers.swarm.status', { swarm_id: required(args[1], 'SWARM_ID') }); break;
    case 'cancel': result = await managementRpc('workers.swarm.cancel', { swarm_id: required(args[1], 'SWARM_ID'), request_id: requestId() }); break;
    case 'help': console.log(help); return;
    default: throw new Error(`Unknown swarm command: ${command}\n${help}`);
  }
  console.log(JSON.stringify(result, null, 2));
}
