import type { QuotaSnapshot, QuotaBucket } from '../schema.js';
import { now } from '../util.js';
const percent = (x: unknown): number | null =>
  typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 100 ? x : null;
const reset = (x: unknown): string | null => {
  if (typeof x === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(x.trim())) x = Number(x.trim());
  const value =
    typeof x === 'number' && Number.isFinite(x)
      ? Math.abs(x) >= 1e11
        ? x
        : x * 1000
      : typeof x === 'string'
        ? Date.parse(x)
        : NaN;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
export function codexQuota(accountId: string, input: any): QuotaSnapshot {
  const buckets: QuotaBucket[] = [];
  const limits: Record<string, unknown> = {
    ...(input?.rateLimits ? { codex: input.rateLimits } : {}),
  };
  if (
    input?.rateLimitsByLimitId &&
    typeof input.rateLimitsByLimitId === 'object' &&
    !Array.isArray(input.rateLimitsByLimitId)
  ) {
    for (const [id, limit] of Object.entries(input.rateLimitsByLimitId)) {
      if (limit && typeof limit === 'object') {
        const prior = (limits[id] as any) ?? {};
        const merged = { ...prior, ...limit };
        for (const window of ['primary', 'secondary']) {
          if ((limit as any)[window] && prior[window])
            merged[window] = { ...prior[window], ...(limit as any)[window] };
        }
        limits[id] = merged;
      }
    }
  }
  for (const [key, value] of Object.entries(limits)) {
    const limit = value as any;
    if (!limit || typeof limit !== 'object') continue;
    for (const window of ['primary', 'secondary']) {
      const w = limit[window];
      if (!w) continue;
      const used = percent(w.usedPercent);
      buckets.push({
        id: `${key}/${window}`,
        name: `${limit.limitName ?? key} ${window}`,
        models: key === 'codex' ? [] : limit.normalModelSlug ? [limit.normalModelSlug] : [],
        scopeKnown: key === 'codex' || typeof limit.normalModelSlug === 'string',
        remainingPercent: used === null ? null : 100 - used,
        resetAt: reset(w.resetsAt),
        windowMinutes: typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null,
      });
    }
  }
  return {
    accountId,
    observedAt: now(),
    source: 'codex/account/rateLimits/read',
    state: buckets.some((b) => b.remainingPercent !== null) ? 'reported' : 'unknown',
    buckets,
  };
}
export function agyQuota(accountId: string, input: any): QuotaSnapshot {
  const groups = input?.command?.data?.groups;
  const buckets: QuotaBucket[] = [];
  if (!Array.isArray(groups))
    return {
      accountId,
      observedAt: now(),
      source: 'antigravity/usage',
      state: 'unsupported',
      buckets,
      error: 'Unrecognized /usage response; no estimated allowance substituted',
    };
  for (const g of groups) {
    if (!Array.isArray(g.buckets)) continue;
    for (const b of g.buckets) {
      const frac =
        typeof b.remaining_fraction === 'number' &&
        b.remaining_fraction >= 0 &&
        b.remaining_fraction <= 1
          ? b.remaining_fraction
          : null;
      buckets.push({
        id: `${g.id ?? g.name ?? 'group'}/${b.id ?? b.name ?? b.window ?? buckets.length}`,
        name: `${g.name ?? 'Unknown group'} ${b.name ?? b.window ?? 'Unknown window'}`,
        scopeKnown: Array.isArray(g.models) && g.models.length > 0,
        models: Array.isArray(g.models)
          ? g.models.filter((x: unknown) => typeof x === 'string')
          : [],
        remainingPercent: frac === null ? null : frac * 100,
        resetAt: reset(b.reset_time),
        windowMinutes:
          typeof b.window_duration_minutes === 'number' ? b.window_duration_minutes : null,
      });
    }
  }
  return {
    accountId,
    observedAt: now(),
    source: 'antigravity/usage',
    state: buckets.some((b) => b.remainingPercent !== null) ? 'reported' : 'unknown',
    buckets,
  };
}
export function headroom(q: QuotaSnapshot | null, model?: string): number | null {
  if (!q || q.state !== 'reported') return null;
  const relevant = q.buckets.filter((b) => !model || !b.models.length || b.models.includes(model));
  // Without a model pin, conservatively reserve against every reported bucket.
  // A pinned model still requires authoritative bucket membership.
  // Missing windows may be restrictive. Never treat a partly unknown snapshot as fully known.
  if (
    !relevant.length ||
    relevant.some((b) => b.remainingPercent === null || (!!model && b.scopeKnown === false))
  )
    return null;
  return Math.min(...relevant.map((b) => b.remainingPercent!));
}
export function classifyFailure(
  message: string,
): 'quota' | 'auth' | 'policy' | 'model' | 'transient' | 'failed' {
  if (/suspend|policy.?violation|account.?deactivat|access.?denied|account.?banned/i.test(message))
    return 'policy';
  if (/retry.?after|too many requests|throttl/i.test(message)) return 'transient';
  if (/quota|usage.?limit|rate.?limit.?exceed|insufficient.?credit/i.test(message)) return 'quota';
  if (
    /unauthoriz|authentication|invalid.?grant|revoked|expired.?token|sign.?in|log.?in/i.test(
      message,
    )
  )
    return 'auth';
  if (/model.*(?:unavailable|not.?found|not.?supported|not.?permitted)/i.test(message))
    return 'model';
  if (/temporar|overload|502|503|504|ECONNRESET|ETIMEDOUT/i.test(message)) return 'transient';
  return 'failed';
}

// Only protocol discriminants can change account or quota state. Provider prose,
// model summaries, compiler output and permission errors are not discriminants.
export function classifyProviderFailure(error: unknown): ReturnType<typeof classifyFailure> {
  if (!error || typeof error !== 'object') return 'failed';
  const e = error as any;
  const code = typeof e.codexErrorInfo === 'string' ? e.codexErrorInfo : (e.code ?? e.type);
  if (
    [
      'usageLimitExceeded',
      'rateLimitExceeded',
      'usage_limit_exceeded',
      'insufficient_quota',
    ].includes(code)
  )
    return 'quota';
  if (['unauthorized', 'invalid_grant', 'invalid_api_key', 'authentication_error'].includes(code))
    return 'auth';
  if (['account_deactivated', 'account_suspended', 'account_banned'].includes(code))
    return 'policy';
  if (['model_not_found', 'model_not_supported'].includes(code)) return 'model';
  if (['serverOverloaded', 'internalServerError', 'rate_limit_error'].includes(code))
    return 'transient';
  const status = e.httpStatusCode ?? e.status;
  if (status === 401) return 'auth';
  if ([429, 502, 503, 504].includes(status)) return 'transient';
  for (const child of [
    e.error,
    e.data,
    e.codexErrorInfo,
    e.httpConnectionFailed,
    e.responseStreamConnectionFailed,
    e.responseStreamDisconnected,
  ]) {
    const kind = classifyProviderFailure(child);
    if (kind !== 'failed') return kind;
  }
  return 'failed';
}
