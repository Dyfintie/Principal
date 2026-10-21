import { z } from 'zod';
import { WorkerStart } from './worker-model.js';

export const SwarmTaskSchema = WorkerStart.omit({ request_id: true, timeout_seconds: true }).extend({ id: z.string().min(1).max(160).optional() });
export const SwarmDeploySchema = z.object({
  request_id: z.string().min(1).max(160),
  provider: z.enum(['codex', 'antigravity', 'copilot']).optional(),
  tasks: z.array(SwarmTaskSchema).min(1, 'Must provide at least one task').max(32),
  wait_for_completion: z.literal(false).default(false),
  timeout_seconds: z.number().int().min(5).max(86400).default(300),
  max_parallel: z.number().int().min(1).max(32).optional(),
}).strict().superRefine((value, context) => {
  const explicitIds = value.tasks.map((t) => t.id).filter((id) => id !== undefined);
  if (new Set(explicitIds).size !== explicitIds.length) context.addIssue({ code: 'custom', message: 'Task IDs must be unique' });
  if (new Set(value.tasks.map((t) => t.profile_id)).size !== value.tasks.length) context.addIssue({ code: 'custom', message: 'Each task needs a different explicit profile; use worker follow-ups for sequential work' });
  if (value.max_parallel !== undefined && value.max_parallel < value.tasks.length) context.addIssue({ code: 'custom', message: 'Submit a smaller explicitly assigned batch instead of queueing behind max_parallel' });
});
export type SwarmTask = z.infer<typeof SwarmTaskSchema>;
export type SwarmDeployOptions = z.infer<typeof SwarmDeploySchema>;
