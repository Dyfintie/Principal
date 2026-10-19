import { cleanText } from './util.js';

const percentageFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: false,
});
export function formatRemainingPercent(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? `${percentageFormat.format(value)}% remaining`
    : 'unknown';
}

type Event = { at: string; type: string; taskId?: string; attemptId?: string; data: any };
export class ReadableLogs {
  private buffers = new Map<string, { event: Event; text: string }>();
  constructor(private write: (line: string) => void) {}
  flush(key?: string, force = false) {
    for (const [id, value] of this.buffers) {
      if (key && id !== key) continue;
      let text = value.text;
      if (text.trimStart().startsWith('{"status"')) {
        try {
          const result = JSON.parse(text);
          text = `Result ${result.status}: ${result.summary}`;
          for (const issue of result.remainingIssues ?? []) text += `\n  - ${issue}`;
        } catch {
          if (!force) continue;
        }
      }
      this.write(
        `${value.event.at.slice(11, 19)} [${value.event.taskId ?? 'run'}] ${cleanText(text)}`,
      );
      this.buffers.delete(id);
    }
  }
  event(e: Event) {
    const key = e.attemptId ?? e.taskId ?? 'run';
    if (e.type === 'text_delta') {
      const previous = this.buffers.get(key);
      const text = (previous?.text ?? '') + (e.data.text ?? '');
      this.buffers.set(key, { event: previous?.event ?? e, text });
      if (text.includes('\n') || text.length > 2000) this.flush(key);
      return;
    }
    if (['quota', 'usage'].includes(e.type)) return;
    this.flush(key, true);
    if (e.type === 'tool' && ['userMessage', 'reasoning', 'agentMessage'].includes(e.data.type))
      return;
    const type =
      e.type === 'terminal'
        ? 'model turn ended'
        : e.type === 'attempt_finished'
          ? 'task finished'
          : e.type;
    const detail = e.type === 'tool' ? e.data.type : JSON.stringify(e.data);
    this.write(`${e.at.slice(11, 19)} [${e.taskId ?? 'run'}] ${type}: ${cleanText(detail ?? '')}`);
  }
}
export function readableStatus(value: any): string {
  if (Array.isArray(value)) return value.map((r) => `${r.id} · ${r.status} · ${r.repo}`).join('\n');
  const lines = [`Run ${value.run.id} · ${value.run.status}`, `Repository: ${value.run.repo}`];
  if (value.run.error) lines.push(`Error: ${value.run.error}`);
  for (const task of value.tasks) {
    const attempts = value.attempts.filter((a: any) => a.taskId === task.id);
    const latest = attempts.at(-1);
    const account = latest
      ? (value.accountLabels?.[latest.accountId] ??
        value.run.graph.tasks.find((t: any) => t.id === task.id)?.account ??
        latest.accountId)
      : 'unassigned';
    lines.push(`\n${task.id} · ${task.status} · ${account}`);
    if (latest)
      lines.push(
        `  Attempt: ${latest.status} · started ${latest.startedAt} · model ${latest.model}`,
      );
    if (task.result) {
      try {
        const result = JSON.parse(task.result);
        lines.push(`  Result: ${result.status}\n${result.summary}`);
        for (const issue of result.remainingIssues ?? []) lines.push(`  - ${issue}`);
      } catch {
        lines.push(`  ${task.result}`);
      }
    }
  }
  return cleanText(lines.join('\n'));
}
