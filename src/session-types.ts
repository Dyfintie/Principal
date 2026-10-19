import type { Config, Provider } from './schema.js';
export type SessionState =
  | 'idle'
  | 'queued'
  | 'running'
  | 'waiting_quota'
  | 'waiting_workers'
  | 'needs_review'
  | 'stopped';
export interface Session {
  id: string;
  parentId: string | null;
  pool: string;
  accountIds: string[];
  leadAccountId: string;
  provider: Provider;
  model: string | null;
  nativeId: string | null;
  nativeAccountId: string | null;
  repo: string;
  workspace: string;
  directoryMode?: boolean;
  liveDirectory?: boolean;
  baseline: string;
  hostFingerprint: string;
  workspaceVersion: number;
  reviewedVersion: number | null;
  reviewedHash: string | null;
  status: SessionState;
  createdAt: string;
  config: Config;
  error: string | null;
  checkpointId: string | null;
  activeRunId: string | null;
  startedAt?: string;
  finishedAt?: string;
  lastActivityAt?: string;
  currentAction?: string;
  worker?: { runId: string; taskId: string; cursor: number };
}
export interface Turn {
  id: string;
  sessionId: string;
  clientMessageId: string;
  input: string;
  status:
    | 'queued'
    | 'dispatching'
    | 'running'
    | 'completed'
    | 'failed'
    | 'interrupted'
    | 'needs_review';
  delivery: 'steer' | 'queue';
  createdAt: string;
  accountId: string | null;
  container: string | null;
  nativeId: string | null;
  runtimeCursor: number;
  repeatedFailure?: { key: string; count: number };
  contextRebuilds?: number;
  transientRetries?: number;
  notBefore?: number;
  handoffs?: number;
  dispatchAt: string | null;
  error: string | null;
}
export type MessagePart =
  | { type: 'text'; text: string }
  | {
      type: 'tool';
      name: string;
      state: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
      at: string;
    }
  | { type: 'question'; id: string; text: string; answered: boolean }
  | { type: 'result'; runId: string; summary: string }
  | { type: 'context'; operation: string; checkpointId: string | null }
  | { type: 'artifact'; id: string; preview: string };
export interface Message {
  id: string;
  sessionId: string;
  turnId: string | null;
  role: 'user' | 'assistant' | 'system';
  parts: MessagePart[];
  at: string;
}
export interface Checkpoint {
  id: string;
  sessionId: string;
  at: string;
  workspaceVersion: number;
  summary: string;
  recent: string;
  constraints: string;
  estimatedTokens: number;
}
export const leadOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'summary', 'action', 'question', 'tasks', 'retrieval'],
  properties: {
    reply: { type: 'string' },
    summary: { type: 'string' },
    action: {
      type: 'string',
      enum: ['respond', 'ask_question', 'delegate', 'await_workers', 'retrieve_context'],
    },
    question: { type: ['string', 'null'] },
    retrieval: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['artifactId', 'start', 'count', 'query'],
      properties: {
        artifactId: { type: ['string', 'null'] },
        start: { type: 'integer', minimum: 1 },
        count: { type: 'integer', minimum: 1, maximum: 200 },
        query: { type: ['string', 'null'] },
      },
    },
    tasks: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'instruction',
          'mode',
          'writePaths',
          'dependsOn',
          'provider',
          'account',
          'model',
        ],
        properties: {
          id: { type: 'string' },
          instruction: { type: 'string' },
          mode: { type: 'string', enum: ['read', 'write'] },
          writePaths: { type: 'array', items: { type: 'string' } },
          dependsOn: { type: 'array', items: { type: 'string' } },
          provider: { type: ['string', 'null'] },
          account: { type: ['string', 'null'] },
          model: { type: ['string', 'null'] },
        },
      },
    },
  },
};

export function toolState(
  value: unknown,
): 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' {
  switch (String(value ?? 'running').toLowerCase()) {
    case 'done':
    case 'completed':
    case 'success':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'canceled':
    case 'cancelled':
    case 'interrupted':
      return 'interrupted';
    case 'pending':
      return 'pending';
    default:
      return 'running';
  }
}
