import { z } from 'zod';
import type { Installation, ProcessIdentity, Profile } from './model.js';

const request = { request_id: z.string().min(1).max(160) };
const worker = { worker_id: z.string().uuid() };
export const WorkerStart = z.object({
  ...request,
  profile_id: z.string().min(1).max(512),
  cwd: z.string().min(1).max(4096),
  task: z.string().min(1).max(64 * 1024),
  model: z.string().min(1).max(160).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  timeout_seconds: z.number().int().min(5).max(86400).default(300),
  isolate_workspace: z.literal(true).default(true),
}).strict();
export const WorkerControl = z.object({ ...request, ...worker }).strict();
export const WorkerMessage = z.object({
  ...request, ...worker,
  message: z.string().min(1).max(64 * 1024),
  delivery: z.enum(['auto', 'steer', 'next_turn']).default('auto'),
  expected_turn_id: z.string().max(160).optional(),
}).strict();
export const WorkerGet = z.object({
  ...worker,
  cursor: z.number().int().nonnegative().default(0),
  wait_seconds: z.number().min(0).max(25).default(0),
}).strict();
export const WorkerArtifact = z.object({
  ...worker,
  artifact_id: z.string().regex(/^(turn-\d+|final)\.(patch|json)$/),
  offset: z.number().int().nonnegative().default(0),
  length: z.number().int().min(1).max(64 * 1024).default(32 * 1024),
}).strict();

export type WorkerOptions = z.infer<typeof WorkerStart>;
export interface WorkerWorkspace {
  sourceDir: string;
  worktreeDir: string;
  workingDir: string;
  repoRoot: string;
  branchName: string;
  baseRevision: string;
  sourceDirty: boolean;
}
export interface WorkerRecord {
  id: string;
  generation: string;
  profileId: string;
  profileLabel: string;
  tool: 'codex' | 'antigravity' | 'copilot';
  directory: string;
  socket: string;
  createdAt: string;
  requestedModel?: string;
  requestedEffort?: string;
  timeoutSeconds: number;
  workspace?: WorkerWorkspace;
  runner?: ProcessIdentity;
  releasedAt?: string;
  startupError?: string;
  stoppedAt?: string;
}
export interface WorkerTurn {
  id: string;
  number: number;
  requestId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout' | 'interrupted';
  startedAt: string;
  endedAt?: string;
  providerTurnId?: string;
  error?: { category: string; message: string };
  exitCode?: number | null;
  artifacts?: string[];
  captureError?: string;
}
export interface WorkerRuntime {
  generation: string;
  lifecycle: 'starting' | 'ready' | 'running' | 'stopping' | 'stopped' | 'interrupted';
  runner: ProcessIdentity;
  native?: ProcessIdentity;
  ownedProcesses?: ProcessIdentity[];
  isolatedRuntimeDir?: string;
  nativeLaunchPending?: boolean;
  nativeSessionId?: string;
  reportedModel?: string;
  heartbeatAt: string;
  lastProgressAt: string;
  seq: number;
  turn?: WorkerTurn;
  firstTurn?: WorkerTurn;
  paused?: boolean;
  turnCount: number;
  pending: Array<{ requestId: string; message: string }>;
  receipts: Record<string, { hash: string; result: unknown }>;
  error?: { category: string; message: string };
  cleanupRequired?: boolean;
}
export interface WorkerSpec {
  record: WorkerRecord;
  options: WorkerOptions;
  profile: Profile;
  installation: Installation;
  capabilities: WorkerCapabilities;
  resume: boolean;
}
export interface WorkerCapabilities {
  execution: boolean;
  stream: boolean;
  resume: boolean;
  steer: boolean;
  model: boolean;
  effort: string[];
  reason: string;
}
export const stamp = () => new Date().toISOString();
