import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  Callback,
  Label,
  NativeId,
  type Profile,
  type ResourceObservation,
  type Tool,
} from './model.js';

function timestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date =
    typeof value === 'number'
      ? new Date(value * 1000)
      : typeof value === 'string'
        ? new Date(value)
        : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
const percent = z.number().finite().min(0).max(100);
export function normalizeStatusline(
  tool: Tool,
  raw: unknown,
  ancestorPids: number[],
  invocationId?: string,
): Callback {
  const data = z.record(z.string(), z.unknown()).parse(raw) as Record<string, any>;
  const resources: Callback['resources'] = [];
  const warnings: string[] = [];
  let activity: Callback['activity'];
  let conversationId: string | undefined;
  let account: string | undefined;
  let cwd: string | undefined;
  if (tool === 'claude') {
    conversationId = typeof data.session_id === 'string' ? data.session_id : undefined;
    cwd =
      typeof data.workspace?.current_dir === 'string'
        ? data.workspace.current_dir
        : typeof data.cwd === 'string'
          ? data.cwd
          : undefined;
    for (const bucket of ['five_hour', 'seven_day']) {
      const rate = data.rate_limits?.[bucket];
      if (percent.safeParse(rate?.used_percentage).success)
        resources.push({
          metric: 'rate-limit-used',
          bucket,
          value: rate.used_percentage,
          unit: 'percent',
          resetsAt: timestamp(rate.resets_at),
          source: 'Claude native statusline',
          sourceKind: 'official',
        });
    }
    // Context-window percentage is deliberately excluded from subscription usage.
  } else if (tool === 'antigravity') {
    const id = [data.conversation_id, data.session_id].find(
      (value) => NativeId.safeParse(value).success,
    );
    conversationId = typeof id === 'string' ? id : undefined;
    if (
      !conversationId &&
      [data.conversation_id, data.session_id].some((v) => v != null && v !== '')
    )
      warnings.push(
        'Conversation ID format changed; session binding is unavailable. Account and quota updates can continue.',
      );
    cwd = z.string().max(4096).safeParse(data.cwd).success ? data.cwd : undefined;
    const email = Label.safeParse(data.email);
    account = email.success ? email.data : undefined;
    if (!account && data.email != null && data.email !== '')
      warnings.push(
        'Account identity format changed; current identity is unavailable. Quota updates can continue.',
      );
    activity =
      data.tool_confirmation_pending === true
        ? 'awaiting-user'
        : data.agent_state === 'idle'
          ? 'idle'
          : ['thinking', 'working', 'tool_use', 'initializing'].includes(data.agent_state)
            ? 'working'
            : 'unknown';
    if (data.quota != null && (typeof data.quota !== 'object' || Array.isArray(data.quota)))
      warnings.push(
        'Quota format changed; remaining limits are unavailable. Account and session updates can continue.',
      );
    else if (data.quota) {
      let omitted = false;
      for (const [bucket, quota] of Object.entries(data.quota) as [string, any][]) {
        const label = Label.safeParse(bucket);
        if (
          label.success &&
          resources.length < 30 &&
          z.number().finite().min(0).max(1).safeParse(quota?.remaining_fraction).success
        )
          resources.push({
            metric: 'quota-remaining',
            bucket: label.data,
            value: quota.remaining_fraction * 100,
            unit: 'percent',
            resetsAt: timestamp(quota.reset_time),
            source: 'Antigravity native statusline',
            sourceKind: 'official',
          });
        else omitted = true;
      }
      if (omitted)
        warnings.push(
          'Unsupported quota buckets omitted; expected remaining_fraction between 0 and 1 and a valid bucket name (maximum 30 buckets).',
        );
    }
  } else throw new Error('No verified statusline parser for this tool');
  return Callback.parse({
    ...(warnings.length ? { warnings } : {}),
    tool,
    invocationId,
    ancestorPids,
    conversationId,
    cwd,
    activity,
    activitySource: activity ? 'Antigravity native statusline' : undefined,
    account,
    resources,
  });
}
export function normalizeClaudeHook(
  raw: unknown,
  ancestorPids: number[],
  invocationId?: string,
): Callback {
  const data = z.record(z.string(), z.unknown()).parse(raw) as Record<string, any>;
  const event = z
    .enum([
      'UserPromptSubmit',
      'PreToolUse',
      'PermissionRequest',
      'PostToolUse',
      'PostToolUseFailure',
      'Stop',
    ])
    .parse(data.hook_event_name);
  const activity =
    event === 'PermissionRequest' ? 'awaiting-user' : event === 'Stop' ? 'idle' : 'working';
  return Callback.parse({
    tool: 'claude',
    ancestorPids,
    invocationId,
    conversationId: typeof data.session_id === 'string' ? data.session_id : undefined,
    cwd: typeof data.cwd === 'string' ? data.cwd : undefined,
    activity,
    activitySource: `Claude ${event} hook`,
    resources: [],
  });
}
export function normalizeCodexLimits(profile: Profile, raw: unknown): ResourceObservation[] {
  const data = z.record(z.string(), z.unknown()).parse(raw) as Record<string, any>;
  const buckets =
    data.rateLimitsByLimitId && typeof data.rateLimitsByLimitId === 'object'
      ? Object.entries(data.rateLimitsByLimitId)
      : data.rateLimits
        ? [[data.rateLimits.limitId ?? 'codex', data.rateLimits]]
        : [];
  const result: ResourceObservation[] = [];
  for (const [name, rate] of buckets as [string, any][]) {
    for (const window of ['primary', 'secondary']) {
      const item = rate?.[window];
      if (!percent.safeParse(item?.usedPercent).success) continue;
      const id = createHash('sha256')
        .update(`${profile.id}:codex:rate-limit-used:${name}:${window}`)
        .digest('hex')
        .slice(0, 24);
      result.push({
        id,
        profileId: profile.id,
        invocationId: null,
        account: profile.reportedAccount,
        metric: 'rate-limit-used',
        bucket: `${String(name).slice(0, 120)}/${window}${typeof item.windowDurationMins === 'number' ? ` (${item.windowDurationMins}m)` : ''}`,
        value: item.usedPercent,
        unit: 'percent',
        resetsAt: timestamp(item.resetsAt),
        source: 'Codex account/rateLimits/read',
        sourceKind: 'official',
        observedAt: new Date().toISOString(),
      });
    }
  }
  return result;
}
