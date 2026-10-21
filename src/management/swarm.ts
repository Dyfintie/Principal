import { managementRpc } from './client.js';
export { SwarmTaskSchema, SwarmDeploySchema } from './swarm-model.js';
export type { SwarmTask, SwarmDeployOptions } from './swarm-model.js';

// Compatibility names; all execution and state now belong to management.
export async function listSwarmProfiles(): Promise<any[]> { return managementRpc('workers.profiles'); }
export async function deploySwarm(rawOptions: unknown): Promise<any> { return managementRpc('workers.swarm.deploy', rawOptions); }
export async function getSwarmStatus(swarmId: string): Promise<any> { return managementRpc('workers.swarm.status', { swarm_id: swarmId }); }
export async function cancelSwarm(swarmId: string, requestId: string): Promise<any> { return managementRpc('workers.swarm.cancel', { swarm_id: swarmId, request_id: requestId }); }
