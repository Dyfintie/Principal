import type { LaunchOptions } from '../launcher.js';
export type Handoff = (
  | { kind: 'launch'; options: LaunchOptions }
  | { kind: 'resume' | 'login'; id: string; deviceAuth?: boolean; experimentalHistory?: boolean }
  | {
      kind: 'reopen';
      id: string;
      stopInvocationId?: string | null;
      experimentalHistory?: boolean;
      forceStop?: boolean;
    }
  | { kind: 'operation'; run: () => Promise<unknown> }
) & { returnTab?: number; profileTool?: number; profileId?: string };
