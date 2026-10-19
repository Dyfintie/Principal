import type { Account, Config, TaskRecord, QuotaSnapshot } from './schema.js';
import { headroom } from './providers/quota.js';
export function selectAccount(
  task: TaskRecord,
  accounts: Account[],
  quota: (id: string) => QuotaSnapshot | null,
  busy: Set<string>,
  config: Config,
  excluded: Set<string> = new Set(),
) {
  const matching = accounts.filter(
    (a) =>
      a.status === 'ready' &&
      (!a.retryAfter || a.retryAfter <= Date.now()) &&
      !busy.has(a.id) &&
      !excluded.has(a.id) &&
      !task.excludedAccounts?.includes(a.id) &&
      (!task.spec.provider || a.provider === task.spec.provider) &&
      (!task.spec.account ||
        a.label === task.spec.account ||
        a.id === task.spec.account ||
        (task.spec.allowFallback && task.attempts > 0)) &&
      (task.spec.allowFallback || !task.lastAccount || task.lastAccount === a.id),
  );
  const eligible = matching.filter((a) => {
    const q = quota(a.id);
    if (
      q &&
      (q.state === 'stale' ||
        !Number.isFinite(Date.parse(q.observedAt)) ||
        Date.now() - Date.parse(q.observedAt) > config.routing.quotaMaxAgeSeconds * 1000)
    )
      return false;
    if (q?.blockedModels?.some((m) => m === '*' || m === (task.spec.model ?? a.model)))
      return false;
    const value = headroom(q, task.spec.model ?? a.model ?? undefined);
    return value === null
      ? config.routing.allowUnknownQuota
      : value > config.routing.reservePercent;
  });
  return (
    eligible.sort(
      (a, b) =>
        Number(b.id === task.lastAccount) - Number(a.id === task.lastAccount) ||
        a.lastAssigned - b.lastAssigned ||
        (headroom(quota(b.id), task.spec.model ?? b.model ?? undefined) ?? -1) -
          (headroom(quota(a.id), task.spec.model ?? a.model ?? undefined) ?? -1) ||
        a.id.localeCompare(b.id),
    )[0] ?? null
  );
}
