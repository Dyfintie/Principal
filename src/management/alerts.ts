import { exec } from '../util.js';
import { findExecutable } from './providers.js';
import type { Profile } from './model.js';

export interface QuotaAlert {
  type: 'expiring-soon' | 'reset' | 'low-quota';
  profileId: string;
  profileLabel: string;
  bucket: string;
  value: number;
  resetsAt: string | null;
  title: string;
  message: string;
}

export function cleanBucketName(bucket: string): string {
  if (bucket.includes('gemini')) return 'Gemini';
  if (bucket.includes('3p') || bucket.includes('claude') || bucket.includes('gpt')) return 'Claude';
  return bucket;
}

function shouldAlert(
  history: Set<string> | Map<string, number>,
  key: string,
  now: number,
  intervalMs = 3600 * 1000,
): boolean {
  if (history instanceof Map) {
    const last = history.get(key);
    if (last === undefined || now - last >= intervalMs) {
      history.set(key, now);
      return true;
    }
    return false;
  }
  if (history.has(key)) {
    return false;
  }
  for (const entry of history) {
    if (entry.startsWith(key + '@')) {
      const ts = Number(entry.slice(key.length + 1));
      if (!Number.isNaN(ts)) {
        if (now - ts < intervalMs) {
          return false;
        }
        history.delete(entry);
      }
    }
  }
  history.add(`${key}@${now}`);
  return true;
}

export function evaluateQuotaAlerts(
  profiles: Profile[],
  resources: any[],
  alertHistory: Set<string> | Map<string, number>,
  previousQuota: Map<string, number>,
  now = Date.now(),
): QuotaAlert[] {
  const alerts: QuotaAlert[] = [];

  for (const profile of profiles) {
    const profileResources = resources.filter(
      (r) =>
        r.profileId === profile.id ||
        (!r.profileId && r.account && profile.reportedAccount && r.account === profile.reportedAccount),
    );

    const latestByBucket = new Map<string, any>();
    for (const r of profileResources) {
      if (r.unit !== 'percent' || typeof r.value !== 'number') continue;
      const existing = latestByBucket.get(r.bucket);
      if (!existing || (Date.parse(r.observedAt) || 0) > (Date.parse(existing.observedAt) || 0)) {
        latestByBucket.set(r.bucket, r);
      }
    }

    for (const [bucket, r] of latestByBucket.entries()) {
      const remaining = r.metric === 'rate-limit-used' ? 100 - r.value : r.value;
      const cleanBucket = cleanBucketName(bucket);
      const prevKey = `${profile.id}:${bucket}`;
      const prevValue = previousQuota.get(prevKey);
      previousQuota.set(prevKey, remaining);

      // 1. Quota Reset Alert: Previously 0% or <= 5% (exhausted), now back online (>= 30%)
      if (prevValue !== undefined && prevValue <= 5 && remaining >= 30) {
        const alertKey = `${profile.id}:${bucket}:reset:${r.resetsAt ?? 'none'}`;
        if (shouldAlert(alertHistory, alertKey, now, 3600 * 1000)) {
          alerts.push({
            type: 'reset',
            profileId: profile.id,
            profileLabel: profile.label,
            bucket,
            value: remaining,
            resetsAt: r.resetsAt ?? null,
            title: '🎉 Quota Refreshed',
            message: `${profile.label} ${cleanBucket} quota has refreshed (${remaining.toFixed(0)}% remaining)!`,
          });
        }
      }

      // 2. Low Quota Alert: Dropped <= 15% but > 0% (remind in 1h intervals)
      if (remaining <= 15 && remaining > 0) {
        const alertKey = `${profile.id}:${bucket}:low:${r.resetsAt ?? 'none'}`;
        if (shouldAlert(alertHistory, alertKey, now, 3600 * 1000)) {
          alerts.push({
            type: 'low-quota',
            profileId: profile.id,
            profileLabel: profile.label,
            bucket,
            value: remaining,
            resetsAt: r.resetsAt ?? null,
            title: '⚠️ Low Quota Warning',
            message: `${profile.label} ${cleanBucket} is down to ${remaining.toFixed(0)}% remaining.`,
          });
        }
      }

      // 3. Quota Expiring Soon / "Use Your Quota" Reminder:
      // Substantial remaining quota (>= 20%) expiring within 4 hours threshold.
      // Re-notifies in ~1 hour intervals while within the 4h window.
      // Ignore short 5-hour rolling limits (e.g. gemini-5h, 3p-5h, 300m)
      const isFiveHourLimit = /\b5h\b|5-hour|gemini-5h|3p-5h|300m/i.test(bucket) || bucket.includes('5h');
      if (!isFiveHourLimit && remaining >= 20 && r.resetsAt) {
        const resetMs = Date.parse(r.resetsAt);
        const diffMs = resetMs - now;
        if (diffMs > 0 && diffMs <= 4 * 3600 * 1000) {
          const alertKey = `${profile.id}:${bucket}:expiring:${r.resetsAt}`;
          if (shouldAlert(alertHistory, alertKey, now, 3600 * 1000)) {
            const hours = Math.max(1, Math.round(diffMs / 3600000));
            alerts.push({
              type: 'expiring-soon',
              profileId: profile.id,
              profileLabel: profile.label,
              bucket,
              value: remaining,
              resetsAt: r.resetsAt,
              title: '⏳ Unused Quota Expiring Soon',
              message: `${profile.label} has ${remaining.toFixed(0)}% ${cleanBucket} quota expiring in ~${hours}h. Use it before it resets!`,
            });
          }
        }
      }
    }
  }

  return alerts;
}

export async function dispatchAlert(alert: QuotaAlert): Promise<void> {
  if (process.env.NODE_ENV === 'test' || process.env.PRINCIPAL_DISABLE_NOTIFICATIONS === '1') {
    return;
  }

  try {
    const notifySend = await findExecutable('notify-send');
    if (notifySend) {
      await exec(
        notifySend,
        [
          '-a',
          'Principal',
          '-u',
          alert.type === 'low-quota' ? 'critical' : 'normal',
          alert.title,
          alert.message,
        ],
        { timeout: 3000, allowFailure: true },
      );
    }
  } catch {}
}
