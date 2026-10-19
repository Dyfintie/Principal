import type { Account, QuotaBucket, QuotaSnapshot } from './schema.js';
import { cleanText } from './util.js';
import { formatRemainingPercent } from './presentation.js';
export type UsageAccount = { account: Account; quota: QuotaSnapshot | null; busy?: boolean };
export type UsageLine = { text: string; color?: 'cyan' | 'magenta' | 'yellow' | 'gray' | 'red' };
export function resetCountdown(resetAt: string | null, now = Date.now()) {
  const reset = resetAt ? Date.parse(resetAt) : NaN;
  if (!Number.isFinite(reset)) return 'Reset time unknown';
  if (reset <= now) return 'Reset time reached · refresh usage';
  const minutes = Math.ceil((reset - now) / 60000);
  return `Refreshes in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function meter(
  bucket: QuotaBucket | undefined,
  title: string,
  width: number,
  now: number,
  color: UsageLine['color'],
): UsageLine[] {
  const percent = bucket?.remainingPercent;
  const known =
    typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100;
  const slots = Math.max(4, Math.min(50, width - 14));
  const filled = known ? Math.round((slots * percent) / 100) : 0;
  return [
    { text: title, color },
    {
      text: `[${known ? '█'.repeat(filled) + '░'.repeat(slots - filled) : '?'.repeat(slots)}] ${known ? formatRemainingPercent(percent).replace(' remaining', '') : 'unknown'}`,
      color: known ? (percent === 0 ? 'red' : color) : 'gray',
    },
    { text: resetCountdown(bucket?.resetAt ?? null, now), color: 'gray' },
  ];
}
function windowTitle(bucket: QuotaBucket) {
  if (bucket.windowMinutes === 10080) return 'Weekly limit remaining';
  if (bucket.windowMinutes && bucket.windowMinutes >= 1440 && bucket.windowMinutes % 1440 === 0)
    return `${bucket.windowMinutes / 1440}-day limit remaining`;
  if (bucket.windowMinutes && bucket.windowMinutes % 60 === 0)
    return `${bucket.windowMinutes / 60}-hour limit remaining`;
  return cleanText(bucket.name);
}
export const antigravityWindows = [
  { id: 'gemini-weekly', title: 'Gemini · weekly', family: 'gemini', minutes: 10080 },
  { id: '3p-weekly', title: 'Claude · weekly', family: 'claude', minutes: 10080 },
] as const;
/** Display reported weekly windows only; reset proximity is not a quota duration. */
export function antigravityWindow(id: string, name = '', minutes?: number | null) {
  const text = (id + ' ' + name).toLowerCase();
  const gemini = /gemini/.test(text),
    claude = /claude|gpt|(?:^|[^a-z0-9])3p(?:[^a-z0-9]|$)|third[ _-]?party/.test(text);
  if (gemini === claude) return undefined;
  const weekly = /week/.test(text) || minutes === 10080;
  const fiveHour =
    minutes === 300 || /(?:^|[^0-9])5[ _-]?(?:h(?:our|r)?s?)(?:[^a-z0-9]|$)/.test(text);
  if (weekly === fiveHour) return undefined;
  return antigravityWindows.find(
    (w) => w.family === (gemini ? 'gemini' : 'claude') && w.minutes === (weekly ? 10080 : 300),
  );
}
export function usageLines(
  items: UsageAccount[],
  width = 76,
  now = Date.now(),
  activeAccountId?: string,
): UsageLine[] {
  const lines: UsageLine[] = [{ text: 'ACCOUNT USAGE · remaining allowance', color: 'cyan' }];
  if (!items.length)
    return [...lines, { text: 'No connected accounts. Enroll an account to see usage.' }];
  for (const { account, quota, busy } of items) {
    lines.push(
      { text: '' },
      {
        text: `${cleanText(account.label)} · ${account.provider}${account.id === activeAccountId ? ' · active' : ''}${busy ? ' · busy' : ''}`,
        color: 'cyan',
      },
    );
    if (account.identity)
      lines.push({ text: `Account: ${cleanText(account.identity)}`, color: 'gray' });
    const age = quota ? Math.max(0, Math.floor((now - Date.parse(quota.observedAt)) / 60000)) : NaN;
    const stale =
      quota &&
      (quota.state === 'stale' ||
        !Number.isFinite(age) ||
        now - Date.parse(quota.observedAt) > 300000);
    lines.push({
      text: quota
        ? `${stale ? 'STALE · last reported' : quota.state} · observed ${Number.isFinite(age) ? `${age}m ago` : 'at unknown time'}`
        : 'Usage not reported',
      color: stale ? 'yellow' : 'gray',
    });
    const buckets = quota?.buckets ?? [];
    if (account.provider === 'antigravity') {
      for (const window of antigravityWindows) {
        const bucket = buckets.find(
          (b) => antigravityWindow(b.id, b.name, b.windowMinutes)?.id === window.id,
        );
        lines.push(
          ...meter(
            bucket,
            window.title + ' limit remaining',
            width,
            now,
            window.family === 'gemini' ? 'magenta' : 'cyan',
          ),
          { text: '' },
        );
      }
    } else if (buckets.length) {
      for (const bucket of buckets)
        lines.push(...meter(bucket, windowTitle(bucket), width, now, 'cyan'));
    } else lines.push(...meter(undefined, 'Limit remaining', width, now, 'cyan'));
    if (quota?.error) lines.push({ text: cleanText(quota.error), color: 'yellow' });
  }
  return lines;
}
