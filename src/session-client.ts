import { rpc } from './client.js';
import type { SessionRpc } from './session-rpc.js';
export function sessionRpc<M extends keyof SessionRpc>(
  method: M,
  args: SessionRpc[M]['args'],
): Promise<SessionRpc[M]['result']> {
  return rpc(method, args);
}
