import type { Account, Attempt, Event, Run, TaskRecord } from './schema.js';
import { cleanText } from './util.js';
export interface Activity {
  action: string;
  message: string;
  updatedAt: string;
  tokens: number | null;
  endedAt?: string;
}
export class AgentActivity {
  cursor = 0;
  readonly attempts = new Map<string, Activity>();
  ingest(events: Event[]) {
    for (const event of events) {
      if (event.seq <= this.cursor) continue;
      this.cursor = event.seq;
      if (!event.attemptId) continue;
      const data = event.data as any;
      const activity = this.attempts.get(event.attemptId) ?? {
        action: 'Starting worker',
        message: '',
        updatedAt: event.at,
        tokens: null,
      };
      if (event.type === 'text_delta') {
        activity.message = (activity.message + cleanText(data.text ?? '')).slice(-6000);
        activity.action = 'Writing a response';
      } else if (event.type === 'tool') {
        const type = data.type;
        if (type === 'agentMessage') activity.message = '';
        activity.action =
          type === 'commandExecution'
            ? 'Running a command'
            : type === 'webSearch'
              ? 'Searching the web'
              : type === 'reasoning'
                ? 'Thinking'
                : type === 'agentMessage'
                  ? 'Writing a response'
                  : type === 'userMessage'
                    ? 'Reading the task'
                    : `Using ${type ?? 'a tool'}`;
        if (data.command) activity.action += `: ${cleanText(data.command)}`;
      } else if (event.type === 'session') activity.action = 'Session started';
      else if (event.type === 'usage')
        activity.tokens = data.tokenUsage?.total?.totalTokens ?? activity.tokens;
      else if (event.type === 'attempt_finished') {
        activity.action = data.status === 'completed' ? 'Task completed' : 'Task failed';
        activity.endedAt = event.at;
      } else if (event.type === 'dispatch_failed') {
        activity.action = `Startup failed: ${data.error ?? 'unknown error'}`;
        activity.endedAt = event.at;
      } else if (event.type === 'approval_denied') activity.action = 'Permission denied';
      else if (event.type === 'terminal')
        activity.action = 'Model turn ended; checking task output';
      else continue; // Quota telemetry does not imply fresh execution progress.
      activity.updatedAt = event.at;
      this.attempts.set(event.attemptId, activity);
    }
  }
}
export interface AgentCard {
  task: string;
  account: string;
  provider: string;
  model: string;
  status: string;
  action: string;
  message: string;
  result: string;
  instruction: string;
  elapsed: string;
  lastActivity: string;
  tokens: number | null;
  issues: string[];
  attempt: number;
}
export function duration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
export function agentCards(
  state: { run: Run; tasks: TaskRecord[]; attempts: Attempt[] },
  accounts: Account[],
  activity: AgentActivity,
  now = Date.now(),
): AgentCard[] {
  return state.tasks.map((task) => {
    const attempts = state.attempts
      .filter((a) => a.taskId === task.id)
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    const attempt = attempts.at(-1);
    const account = accounts.find((a) => a.id === attempt?.accountId);
    const live = attempt ? activity.attempts.get(attempt.id) : undefined;
    let result = '',
      issues: string[] = [];
    if (task.result) {
      try {
        const parsed = JSON.parse(task.result);
        result = parsed.summary ?? '';
        issues = parsed.remainingIssues ?? [];
      } catch {
        result = task.result;
      }
    }
    const active = attempt && ['starting', 'running'].includes(attempt.status);
    const end = active
      ? now
      : Date.parse(live?.endedAt ?? live?.updatedAt ?? attempt?.startedAt ?? '') || now;
    if (active || task.status === 'pending') {
      result = '';
      issues = [];
    }
    const unfinished = task.spec.dependsOn.filter(
      (id) => state.tasks.find((t) => t.id === id)?.status !== 'completed',
    );
    const action =
      task.status === 'completed'
        ? 'Task completed'
        : task.status === 'needs_review'
          ? 'Needs review'
          : task.status === 'canceled'
            ? 'Canceled'
            : task.status === 'failed'
              ? 'Task failed'
              : task.status === 'pending'
                ? unfinished.length
                  ? `Waiting for dependencies: ${unfinished.join(', ')}`
                  : state.run.status === 'waiting_quota'
                    ? 'Waiting for eligible account quota'
                    : 'Waiting for a worker slot'
                : (live?.action ?? 'Starting worker');
    return {
      task: task.id,
      account: account?.label ?? task.spec.account ?? 'Not assigned',
      provider: account?.provider ?? task.spec.provider ?? 'Any provider',
      model: attempt?.model ?? task.spec.model ?? account?.model ?? 'Default',
      status: task.status,
      action,
      message: cleanText(live?.message ?? ''),
      result: cleanText(result),
      instruction: cleanText(task.spec.instruction),
      elapsed: attempt ? duration(end - Date.parse(attempt.startedAt)) : '—',
      lastActivity: live ? `${duration(now - Date.parse(live.updatedAt))} ago` : 'No activity yet',
      tokens: live?.tokens ?? null,
      issues: issues.map(cleanText),
      attempt: task.attempts,
    };
  });
}
export function preferredRun(runs: Run[]) {
  const ordered = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return (
    ordered.find((r) => ['planning', 'queued', 'running', 'waiting_quota'].includes(r.status)) ??
    ordered[0]
  );
}
