import { z } from 'zod';
export const Provider = z.enum(['codex', 'antigravity']);
export type Provider = z.infer<typeof Provider>;
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const TaskSchema = z.object({
  id,
  instruction: z.string().min(1).max(100_000),
  mode: z.enum(['read', 'write']).default('write'),
  dependsOn: z.array(id).default([]),
  writePaths: z.array(z.string().min(1)).default([]),
  expectedOutputs: z.array(z.enum(['patch', 'summary', 'validation'])).default(['summary']),
  account: id.optional(),
  provider: Provider.optional(),
  model: z.string().optional(),
  allowFallback: z.boolean().default(true),
});
export type Task = z.infer<typeof TaskSchema>;
export const GraphSchema = z.object({
  schemaVersion: z.literal(1),
  pool: id,
  goal: z.string().optional(),
  tasks: z.array(TaskSchema).min(1).max(20),
});
export type Graph = z.infer<typeof GraphSchema>;
export const ConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  pool: id.default('development'),
  runtime: z
    .object({
      image: z.string().default('principal-runtime:local'),
      cpus: z.number().positive().default(2),
      memoryMiB: z.number().int().min(512).default(2048),
      pids: z.number().int().min(32).default(512),
      proxy: z.string().url().optional(),
    })
    .default({ image: 'principal-runtime:local', cpus: 2, memoryMiB: 2048, pids: 512 }),
  routing: z
    .object({
      workers: z.number().int().min(1).max(32).default(4),
      reservePercent: z.number().min(0).max(99).default(10),
      allowUnknownQuota: z.boolean().default(false),
      quotaMaxAgeSeconds: z.number().min(30).default(300),
      maxHandoffs: z.number().int().min(0).max(20).default(5),
      transientRetries: z.number().int().min(0).max(5).default(2),
    })
    .default({
      workers: 4,
      reservePercent: 10,
      allowUnknownQuota: false,
      quotaMaxAgeSeconds: 300,
      maxHandoffs: 5,
      transientRetries: 2,
    }),
  attemptTimeoutSeconds: z.number().int().min(30).max(86400).default(1800),
  setup: z.array(z.array(z.string()).min(1)).default([]),
  validation: z.array(z.array(z.string()).min(1)).default([]),
  permissions: z
    .object({
      allow: z.array(z.string()).default(['command(*)']),
      deny: z.array(z.string()).default(['mcp(*)', 'execute_url(*)']),
    })
    .default({ allow: ['command(*)'], deny: ['mcp(*)', 'execute_url(*)'] }),
  supervisor: z
    .object({
      maxTasks: z.number().int().min(1).max(20).default(20),
      revisionRounds: z.number().int().min(0).max(2).default(2),
    })
    .default({ maxTasks: 20, revisionRounds: 2 }),
});
export type Config = z.infer<typeof ConfigSchema>;
export interface Account {
  id: string;
  label: string;
  provider: Provider;
  identity: string | null;
  plan: string | null;
  model: string | null;
  status: 'ready' | 'auth_required' | 'disabled' | 'login';
  generation: number;
  lastAssigned: number;
  retryAfter?: number;
}
export interface QuotaBucket {
  id: string;
  name: string;
  models: string[];
  remainingPercent: number | null;
  resetAt: string | null;
  windowMinutes: number | null;
  scopeKnown?: boolean;
}
export interface QuotaSnapshot {
  accountId: string;
  observedAt: string;
  source: string;
  state: 'reported' | 'stale' | 'unknown' | 'unsupported' | 'auth_required';
  buckets: QuotaBucket[];
  error?: string;
  blockedModels?: string[];
}
export type RunStatus =
  | 'planning'
  | 'queued'
  | 'running'
  | 'waiting_quota'
  | 'needs_review'
  | 'ready_for_review'
  | 'failed'
  | 'canceled'
  | 'applied';
export interface Run {
  sessionId?: string;
  id: string;
  repo: string;
  base: string;
  accountIds: string[];
  graph: Graph;
  config: Config;
  status: RunStatus;
  createdAt: string;
  integration: string | null;
  integrationCommit: string | null;
  checkedCommit?: string | null;
  error: string | null;
  supervisor?: { accountId: string; rounds: number };
}
export interface TaskRecord {
  runId: string;
  id: string;
  spec: Task;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'needs_review' | 'canceled';
  checkpoint: string | null;
  checkpointHash?: string;
  result: string | null;
  attempts: number;
  handoffs: number;
  lastAccount: string | null;
  excludedAccounts?: string[];
  notBefore?: number;
  transientRetriesUsed?: number;
  reportRepairs?: number;
}
export interface Attempt {
  id: string;
  runId: string;
  taskId: string;
  accountId: string;
  container: string;
  workspace: string;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'canceled' | 'needs_review';
  cursor: number;
  startedAt: string;
  sessionId: string | null;
  model: string | null;
  checkpointAt?: number;
}
export interface Event {
  seq: number;
  runId: string;
  taskId: string | null;
  attemptId: string | null;
  type: string;
  at: string;
  data: unknown;
}
export function validateGraph(input: unknown): Graph {
  const graph = GraphSchema.parse(input);
  const tasks = new Map(graph.tasks.map((t) => [t.id, t]));
  if (tasks.size !== graph.tasks.length) throw new Error('Task IDs must be unique');
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (name: string) => {
    if (visiting.has(name)) throw new Error(`Dependency cycle at ${name}`);
    if (visited.has(name)) return;
    const task = tasks.get(name);
    if (!task) throw new Error(`Unknown dependency ${name}`);
    visiting.add(name);
    task.dependsOn.forEach(visit);
    visiting.delete(name);
    visited.add(name);
  };
  graph.tasks.forEach((t) => {
    visit(t.id);
    for (const p of t.writePaths)
      if (p.startsWith('/') || p.split('/').includes('..') || p === '.git' || p.startsWith('.git/'))
        throw new Error(`Unsafe write path ${p}`);
    if (t.mode === 'read' && t.expectedOutputs.includes('patch'))
      throw new Error(`Read task ${t.id} cannot produce a source patch`);
    if (t.mode === 'write' && !t.writePaths.length)
      throw new Error(`Task ${t.id} needs explicit writePaths`);
  });
  return graph;
}
export const resultSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'files', 'artifacts', 'validation', 'remainingIssues'],
  properties: {
    status: { type: 'string', enum: ['completed', 'blocked'] },
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    artifacts: { type: 'array', items: { type: 'string' } },
    validation: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'status', 'summary'],
        properties: {
          command: { type: 'string' },
          status: { type: 'string', enum: ['passed', 'failed', 'not_run'] },
          summary: { type: 'string' },
        },
      },
    },
    remainingIssues: { type: 'array', items: { type: 'string' } },
  },
};
export const graphOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'pool', 'tasks'],
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    pool: { type: 'string' },
    tasks: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'instruction',
          'mode',
          'dependsOn',
          'writePaths',
          'expectedOutputs',
          'allowFallback',
        ],
        properties: {
          id: { type: 'string' },
          instruction: { type: 'string' },
          mode: { type: 'string', enum: ['read', 'write'] },
          dependsOn: { type: 'array', items: { type: 'string' } },
          writePaths: { type: 'array', items: { type: 'string' } },
          expectedOutputs: {
            type: 'array',
            items: { type: 'string', enum: ['patch', 'summary', 'validation'] },
          },
          allowFallback: { type: 'boolean' },
        },
      },
    },
  },
};

export const supervisorReviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'summary'],
  properties: {
    decision: { type: 'string', enum: ['accept', 'revise', 'blocked'] },
    summary: { type: 'string' },
  },
};

export const ResultSchema = z
  .object({
    status: z.enum(['completed', 'blocked']),
    summary: z.string().min(1),
    files: z.array(z.string()),
    artifacts: z.array(z.string()),
    validation: z.array(
      z
        .object({
          command: z.string(),
          status: z.enum(['passed', 'failed', 'not_run']),
          summary: z.string(),
        })
        .strict(),
    ),
    remainingIssues: z.array(z.string()),
  })
  .strict();
