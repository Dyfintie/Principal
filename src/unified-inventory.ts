import { stat } from 'node:fs/promises';
import { managementRpc } from './management/client.js';
import { discoverNativeProfiles } from './management/discovery.js';
import { freshness, type Snapshot, type ResourceObservation } from './management/model.js';
import { existingUsage } from './client.js';
import Database from 'better-sqlite3';
import { paths, cleanText } from './util.js';
import {
  usageLines,
  resetCountdown,
  antigravityWindow,
  antigravityWindows,
  type UsageAccount,
  type UsageLine,
} from './usage-view.js';

export interface UnifiedInventory {
  native: Snapshot | null;
  enrolled: UsageAccount[];
  warnings: string[];
}
/** Read cached metadata only; do not instantiate the migrating/writable Store. */
export function cachedEnrolledUsage(file = paths.db): UsageAccount[] {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      const accounts = db.prepare('SELECT data FROM accounts').all() as { data: string }[];
      const quota = db.prepare('SELECT data FROM quotas WHERE account_id = ?');
      return accounts.map((row) => {
        const account = JSON.parse(row.data) as UsageAccount['account'];
        const record = quota.get(account.id) as { data: string } | undefined;
        return { account, quota: record ? JSON.parse(record.data) : null };
      });
    })();
  } finally {
    db.close();
  }
}
export function timeAgo(timestamp: string, now = Date.now()): string {
  const diffMs = now - Date.parse(timestamp);
  if (!Number.isFinite(diffMs) || diffMs < 0) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min === 1) return '1 min ago';
  if (min < 60) return `${min} mins ago`;
  const hr = Math.floor(min / 60);
  if (hr === 1) return '1 hour ago';
  if (hr < 24) return `${hr} hours ago`;
  const days = Math.floor(hr / 24);
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

export function pulseStatus(observedAt: string, now = Date.now()): string {
  const isFresh = freshness(observedAt, now) === 'cached';
  const icon = isFresh ? '●' : '○';
  return `${icon} refreshed ${timeAgo(observedAt, now)}`;
}

export async function inventory(
  options: { refresh?: boolean; nativeRefresh?: boolean; inspect?: boolean } = {},
): Promise<UnifiedInventory> {
  const warnings: string[] = [];
  const [nativeResult, enrolledResult] = await Promise.allSettled([
    (async () => {
      const discovered = await discoverNativeProfiles();
      warnings.push(...discovered.skipped.map((s: any) => `${s.tool}: ${s.reason}`));
      if (options.refresh || options.nativeRefresh) {
        const result = await managementRpc('resources.refresh');
        const profiles: Snapshot['profiles'] = await managementRpc('profiles.list');
        warnings.push(
          ...result.results
            .filter((r: any) => !r.refreshed && r.reason)
            .map((r: any) => {
              const profile = profiles.find((p) => p.id === r.profileId);
              return profile ? `${profile.tool}: ${r.reason}` : r.reason;
            }),
        );
      }
      if (options.inspect || discovered.profiles.some((p) => p.tool === 'copilot')) {
        const profiles: Snapshot['profiles'] = options.inspect
          ? await managementRpc('profiles.list')
          : discovered.profiles.filter((p) => p.tool === 'copilot');
        // Bounded read-only native checks. Unsupported identities remain unknown.
        for (let i = 0; i < profiles.length; i += 2)
          await Promise.all(
            profiles.slice(i, i + 2).map(async (profile) => {
              if (!['codex', 'claude', 'copilot'].includes(profile.tool)) return;
              try {
                await managementRpc('profiles.inspect', { profile: profile.id });
              } catch (error) {
                warnings.push(`${profile.tool}: ${profile.label}: ${(error as Error).message}`);
              }
            }),
          );
      }
      return managementRpc('snapshot') as Promise<Snapshot>;
    })(),
    (async () => {
      // Do not start the optional orchestration runtime for an empty native-only installation.
      try {
        await stat(paths.db);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      // Reuse a running service for cached metadata only. Never auto-start the
      // historical task engine, even when the user explicitly refreshes usage.
      try {
        const result = (await existingUsage()) as UsageAccount[];
        if (options.refresh)
          warnings.push(
            'Enrolled accounts: cached observations only; management does not start or refresh historical execution runtimes.',
          );
        return result;
      } catch (error) {
        if (
          !['ENOENT', 'ECONNREFUSED', 'ETIMEDOUT'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw error;
        warnings.push(
          'Enrolled accounts: cached local metadata; authentication and activity are not live-verified.',
        );
        return cachedEnrolledUsage();
      }
    })(),
  ]);
  if (nativeResult.status === 'rejected')
    warnings.push(`Native management unavailable: ${nativeResult.reason.message}`);
  if (enrolledResult.status === 'rejected')
    warnings.push(`Enrolled account inventory unavailable: ${enrolledResult.reason.message}`);
  return {
    native: nativeResult.status === 'fulfilled' ? nativeResult.value : null,
    enrolled:
      enrolledResult.status === 'fulfilled'
        ? enrolledResult.value.filter(
            (item) =>
              nativeResult.status !== 'fulfilled' ||
              !nativeResult.value.dismissedAccountIds?.includes(item.account.id),
          )
        : [],
    warnings,
  };
}
export function inventoryAccounts(value: UnifiedInventory): string[] {
  const lines = ['ACCOUNTS · existing native profiles and Principal-enrolled accounts'];
  const tools = new Set([
    ...(value.native?.profiles.map((p) => p.tool) ?? []),
    ...value.enrolled.map((i) => i.account.provider),
  ]);
  for (const tool of tools) {
    lines.push(`▾ ${tool}`);
    for (const p of value.native?.profiles.filter((p) => p.tool === tool) ?? []) {
      lines.push(
        `  ├─ ${p.label} · ${p.auth === 'unknown' ? 'login not verified' : p.auth}${p.authObservedAt ? ` / ${freshness(p.authObservedAt)}` : ''}`,
        `  │  Account: ${p.reportedAccount ?? 'not verified'} · ${p.plan ?? 'plan not reported'}`,
        `  │  Configuration: ${p.directory}`,
        ...(p.tool === 'antigravity' && p.auth === 'unknown'
          ? ['  │  Native login status cannot be checked here; unknown does not mean logged out.']
          : []),
      );
    }
    for (const { account, busy } of value.enrolled.filter((i) => i.account.provider === tool))
      lines.push(
        `  ├─ ${account.label} · enrolled / ${account.status}${busy ? ' / busy' : ''}`,
        `  │  Account: ${account.identity ?? 'not reported'}`,
      );
  }
  if (!tools.size) lines.push('No existing profiles discovered. /profiles opens account setup.');
  lines.push(
    '',
    'A profile is a configuration, not proof of a logged-in account.',
    'Default native directories are discovered locally. Other environments and private account stores are not enumerated.',
    '/profiles → Check authentication or native sign-in · /usage for limits',
  );
  return [...lines, ...value.warnings.map((w) => `Warning: ${cleanText(w)}`)];
}
export function inventoryUsage(
  value: UnifiedInventory,
  width: number,
  now = Date.now(),
): UsageLine[] {
  const lines: UsageLine[] = [
    { text: 'ACCOUNT USAGE · all discovered profiles and enrolled accounts', color: 'cyan' },
  ];
  for (const p of value.native?.profiles ?? []) {
    const observations = value.native!.resources.filter(
      (r) =>
        r.profileId === p.id ||
        (!r.profileId && Boolean(r.account && p.reportedAccount && r.account === p.reportedAccount)),
    );
    const displayObservations = (() => {
      if (p.tool === 'codex') {
        const byWindow = new Map<string, ResourceObservation>();
        const sorted = [...observations].sort(
          (a, b) => (Date.parse(b.observedAt) || 0) - (Date.parse(a.observedAt) || 0),
        );
        for (const r of sorted) {
          const windowKey = r.bucket.split(' ')[0];
          if (!byWindow.has(windowKey)) {
            byWindow.set(windowKey, r);
          }
        }
        return Array.from(byWindow.values());
      }
      return observations;
    })();
    const profileHeadroom = (() => {
      let maxVal: number | null = null;
      for (const r of displayObservations) {
        if (r.unit === 'percent' && typeof r.value === 'number') {
          const val = r.metric === 'rate-limit-used' ? 100 - r.value : r.value;
          if (maxVal === null || val > maxVal) maxVal = val;
        }
      }
      if (maxVal === null) return '';
      if (maxVal >= 30) return ' · ● available';
      if (maxVal > 0) return ' · ▲ low quota';
      return ' · ○ exhausted';
    })();
    lines.push(
      { text: '' },
      {
        text: `▾ ${p.tool} / ${p.label} · ${p.reportedAccount ?? 'account not verified'}${profileHeadroom}`,
        color: 'cyan',
      },
    );
    for (const warning of p.observationWarnings ?? [])
      lines.push({ text: `  ${cleanText(warning)}`, color: 'gray' });
    if (p.observationError)
      lines.push({
        text: `  ${p.observationError.reason}${p.observationError.retryAt ? ' Retry ' + p.observationError.retryAt : ''}`,
        color: 'yellow',
      });
    if (!observations.length) {
      const installation = value.native!.installations.find((i) => i.tool === p.tool);
      const callbackUsage =
        ['claude', 'antigravity'].includes(p.tool) &&
        installation?.capabilities.observer?.supported;
      lines.push({
        text: callbackUsage
          ? '  Waiting for profile-bound usage · native statusline updates arrive automatically; refresh does not poll this provider.'
          : `  Usage unavailable · ${installation?.capabilities.resources.reason ?? 'No supported observations'}`,
        color: 'gray',
      });
    }
    if (p.tool === 'antigravity') {
      const latestScope =
        [...observations]
          .filter((r) => antigravityWindow(r.bucket))
          .sort((a, b) => (Date.parse(b.observedAt) || 0) - (Date.parse(a.observedAt) || 0))[0]
          ?.account ?? null;
      const accountScope = p.reportedAccount ?? latestScope;
      for (const window of antigravityWindows) {
        const candidates = observations.filter(
          (r) =>
            r.unit === 'percent' &&
            ['quota-remaining', 'rate-limit-used'].includes(r.metric) &&
            Number.isFinite(r.value) &&
            r.value >= 0 &&
            r.value <= 100 &&
            antigravityWindow(r.bucket)?.id === window.id &&
            (r.account ?? null) === accountScope,
        );
        candidates.sort(
          (a, b) => (Date.parse(b.observedAt) || 0) - (Date.parse(a.observedAt) || 0),
        );
        const r = candidates[0];
        const rFresh = r ? freshness(r.observedAt, now) === 'cached' : false;
        lines.push({
          text: `  ├─ ${window.title} · ${r ? pulseStatus(r.observedAt, now) : 'unavailable'}`,
          color: rFresh ? 'cyan' : 'yellow',
        });
        if (!r) {
          const suffix = ' unavailable · not reported for this account';
          const availableSlots = width - 7 - suffix.length;
          const slots = Math.max(8, Math.min(200, availableSlots));
          lines.push({
            text: `  │  [${'?'.repeat(slots)}]${suffix}`,
            color: 'gray',
          });
          continue;
        }
        const remaining = r.metric === 'rate-limit-used' ? 100 - r.value : r.value;
        const countdown = r.resetsAt ? ` · ${resetCountdown(r.resetsAt, now)}` : '';
        const suffix = ` ${remaining.toFixed(1)}% remaining${countdown}`;
        const availableSlots = width - 7 - suffix.length;
        const slots = Math.max(8, Math.min(200, availableSlots));
        const count = Math.round((slots * remaining) / 100);
        lines.push({
          text: `  │  [${'█'.repeat(count)}${'░'.repeat(slots - count)}]${suffix}`,
          color: 'cyan',
        });
      }
      continue;
    }
    for (const r of displayObservations) {
      const remaining = r.metric === 'rate-limit-used' ? 100 - r.value : r.value;
      const rFresh = freshness(r.observedAt, now) === 'cached';
      lines.push({
        text: `  ├─ ${r.bucket} · ${freshness(r.observedAt, now)} · ${r.sourceKind} · ${pulseStatus(r.observedAt, now)}`,
        color: rFresh ? 'cyan' : 'yellow',
      });
      const countdown = r.resetsAt ? ` · ${resetCountdown(r.resetsAt, now)}` : '';
      if (r.unit === 'percent' && ['rate-limit-used', 'quota-remaining'].includes(r.metric)) {
        const suffix = ` ${remaining.toFixed(1)}% ${r.metric === 'quota-remaining' ? 'quota' : 'window'} remaining${countdown}`;
        const availableSlots = width - 7 - suffix.length;
        const slots = Math.max(8, Math.min(200, availableSlots));
        const count = Math.round((slots * Math.max(0, Math.min(100, remaining))) / 100);
        lines.push({
          text: `  │  [${'█'.repeat(count)}${'░'.repeat(slots - count)}]${suffix}`,
          color: 'cyan',
        });
      } else lines.push({ text: `  │  ${r.metric}: ${r.value} ${r.unit}${countdown}` });
      if (r.quota)
        lines.push({
          text: `  │  Provider entitlement: ${r.quota.used ?? 'unknown'} used / ${r.quota.unlimited || r.quota.allowance === -1 ? 'unlimited' : (r.quota.allowance ?? 'unknown')} · native quota units`,
        });
    }
  }
  for (const r of value.native?.resources.filter(
    (r) =>
      !r.profileId &&
      (!r.account || !value.native?.profiles.some((p) => p.reportedAccount === r.account)),
  ) ?? [])
    lines.push({
      text: `External observation · ${r.account ?? 'account unknown'} · ${r.bucket}: ${r.value} ${r.unit} ${r.metric} · ${freshness(r.observedAt, now)}`,
    });
  if (value.enrolled.length)
    lines.push(
      { text: '' },
      { text: 'PRINCIPAL-ENROLLED ACCOUNTS · separate authentication scope', color: 'cyan' },
      ...usageLines(value.enrolled, width, now).slice(1),
    );
  if (!value.native?.profiles.length && !value.enrolled.length)
    lines.push({ text: 'No profiles found. /profiles opens setup.' });
  lines.push(
    { text: '' },
    {
      text: 'Unknown balances stay unavailable. Profiles may refer to the same account; limits are never added together.',
      color: 'gray',
    },
  );
  lines.push(
    ...value.warnings.map((w): UsageLine => ({
      text: `Warning: ${cleanText(w)}`,
      color: 'yellow',
    })),
  );
  return lines;
}

/** UI catalog only: a tab does not imply an installed or supported adapter. */
export const usageTools = [
  { id: 'codex', label: 'Codex' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'copilot', label: 'Copilot' },
  { id: 'claude', label: 'Claude' },
] as const;

export function smartQuotaRecommendations(
  tool: string,
  profiles: NonNullable<Snapshot['profiles']>,
  resources: NonNullable<Snapshot['resources']>,
): string | null {
  if (profiles.length <= 1) return null;

  if (tool === 'antigravity') {
    let bestGemini: { label: string; value: number } | null = null;
    let bestClaude: { label: string; value: number } | null = null;

    for (const p of profiles) {
      const pResources = resources.filter(
        (r) =>
          r.profileId === p.id ||
          (!r.profileId && Boolean(r.account && p.reportedAccount && r.account === p.reportedAccount)),
      );
      for (const window of antigravityWindows) {
        const candidates = pResources.filter(
          (r) =>
            r.unit === 'percent' &&
            ['quota-remaining', 'rate-limit-used'].includes(r.metric) &&
            Number.isFinite(r.value) &&
            r.value >= 0 &&
            r.value <= 100 &&
            antigravityWindow(r.bucket)?.id === window.id,
        );
        candidates.sort(
          (a, b) => (Date.parse(b.observedAt) || 0) - (Date.parse(a.observedAt) || 0),
        );
        const r = candidates[0];
        if (!r) continue;
        const remaining = r.metric === 'rate-limit-used' ? 100 - r.value : r.value;
        if (window.family === 'gemini') {
          if (!bestGemini || remaining > bestGemini.value) {
            bestGemini = { label: p.label, value: remaining };
          }
        } else if (window.family === 'claude') {
          if (!bestClaude || remaining > bestClaude.value) {
            bestClaude = { label: p.label, value: remaining };
          }
        }
      }
    }

    const parts: string[] = [];
    if (bestGemini) parts.push(`Optimal Gemini → ${bestGemini.label} (${bestGemini.value.toFixed(1)}%)`);
    if (bestClaude) parts.push(`Optimal Claude → ${bestClaude.label} (${bestClaude.value.toFixed(1)}%)`);
    if (parts.length) return `💡 Smart Router: ${parts.join(' · ')}`;
    return null;
  }

  let bestProfile: { label: string; value: number } | null = null;
  for (const p of profiles) {
    const candidates = resources.filter(
      (r) =>
        (r.profileId === p.id ||
          (!r.profileId && Boolean(r.account && p.reportedAccount && r.account === p.reportedAccount))) &&
        r.unit === 'percent' &&
        typeof r.value === 'number',
    );
    candidates.sort(
      (a, b) => (Date.parse(b.observedAt) || 0) - (Date.parse(a.observedAt) || 0),
    );
    const r = candidates[0];
    if (!r) continue;
    const remaining = r.metric === 'rate-limit-used' ? 100 - r.value : r.value;
    if (!bestProfile || remaining > bestProfile.value) {
      bestProfile = { label: p.label, value: remaining };
    }
  }
  if (bestProfile) {
    return `💡 Smart Router: Optimal account → ${bestProfile.label} (${bestProfile.value.toFixed(1)}% remaining)`;
  }
  return null;
}

export function providerUsage(
  value: UnifiedInventory,
  tool: string,
  width: number,
  now = Date.now(),
): UsageLine[] {
  const profiles = value.native?.profiles.filter((p) => p.tool === tool) ?? [];
  const ids = new Set(profiles.map((p) => p.id));
  const filtered: UnifiedInventory = {
    native: value.native
      ? {
          ...value.native,
          profiles,
          installations: value.native.installations.filter((i) => i.tool === tool),
          resources: value.native.resources.filter((r) => {
            if (r.profileId) return ids.has(r.profileId);
            // Only attribute external observations when their invocation is known.
            const invocation = value.native!.invocations?.find((i) => i.id === r.invocationId);
            return (
              !!invocation &&
              value.native!.entries?.find((e) => e.id === invocation.entryId)?.tool === tool
            );
          }),
        }
      : null,
    enrolled: value.enrolled.filter((i) => i.account.provider === tool),
    warnings: value.warnings.filter((warning) => {
      const prefix = warning.split(':')[0];
      return !usageTools.some((t) => t.id === prefix) || prefix === tool;
    }),
  };
  const lines = inventoryUsage(filtered, width, now);
  lines[0] = {
    text: `ACCOUNT USAGE · ${usageTools.find((t) => t.id === tool)?.label ?? tool}`,
    color: 'cyan',
  };
  if (profiles.length > 1) {
    const recommendation = smartQuotaRecommendations(tool, profiles, value.native?.resources ?? []);
    if (recommendation) {
      lines.splice(1, 0, { text: recommendation, color: 'cyan' });
    }
  }
  if (!profiles.length && !filtered.enrolled.length) {
    lines.splice(1, 0, {
      text: 'Usage unavailable · no accounts or profiles discovered for this tool.',
      color: 'gray',
    });
  }
  return lines;
}

export interface ProfileInventoryRow {
  id: string;
  label: string;
  tool: string;
  status: string;
  detail: string[];
  nativeProfile?: Snapshot['profiles'][number];
}
/** Shared metadata view; cached accounts and external sessions are not login profiles. */
export function profileInventory(value: UnifiedInventory): ProfileInventoryRow[] {
  const snapshot = value.native;
  const active = snapshot?.invocations?.filter((i) => !i.endedAt && i.lifecycle !== 'exited') ?? [];
  const processStatus = (profileId: string) => {
    const related = active.filter((i) => i.profileId === profileId);
    const running = related.filter((i) => i.lifecycle === 'running').length;
    const uncertain = related.length - running;
    return `${running} running process${running === 1 ? '' : 'es'}${uncertain ? ` · ${uncertain} starting/uncertain` : ''}`;
  };
  const rows: ProfileInventoryRow[] = (snapshot?.profiles ?? []).map((p) => ({
    id: `native:${p.id}`,
    label: p.label,
    tool: p.tool,
    status: `${p.isolated ? (p.tool === 'antigravity' ? 'isolated config (experimental)' : 'isolated config') : 'native config'} · auth ${p.observationError?.category === 'authentication' ? '[!] Rejected (401) · l sign in' + (p.tool === 'codex' ? ' / D device login' : '') : p.auth === 'unknown' ? 'not verified' : p.auth} · ${processStatus(p.id)}`,
    nativeProfile: p,
    detail: [
      `Configuration: ${p.directory}`,
      `History: ${(p.sharedHistory ?? true) ? 'shared common history' : 'isolated history'}`,
      `Account: ${p.reportedAccount ?? 'not verified'}`,
      `Authentication: ${p.auth}${p.authObservedAt ? ` / ${freshness(p.authObservedAt)}` : ''}`,
      ...(p.observationError
        ? [
            p.observationError.reason,
            ...(p.observationError.retryAt
              ? [`Next observation retry: ${p.observationError.retryAt}`]
              : []),
          ]
        : []),
      ...(p.tool === 'antigravity' && p.auth === 'unknown'
        ? ['No supported native login-status check; this does not mean logged out.']
        : []),
    ],
  }));
  for (const item of value.enrolled)
    rows.push({
      id: `enrolled:${item.account.id}`,
      label: item.account.label,
      tool: item.account.provider,
      status: 'enrolled account · cached · login and active sessions not verified',
      detail: [
        `Account: ${item.account.identity ?? 'not reported'}`,
        `Cached state: ${item.account.status}`,
        'Saved metadata from Principal’s earlier account system.',
        'This entry has no confirmed native configuration. It cannot be signed in or launched as a native profile.',
        'Use Add existing login / new profile to register a native configuration; credentials are not copied.',
      ],
    });
  for (const invocation of active.filter((i) => !i.profileId)) {
    const entry = snapshot?.entries.find((e) => e.id === invocation.entryId);
    if (!entry) continue;
    const project = snapshot?.projects.find((p) => p.id === entry.projectId);
    rows.push({
      id: `external:${invocation.id}`,
      label: entry.title,
      tool: entry.tool,
      status: `external process · profile unassigned · account ${invocation.reportedAccount ?? 'not verified'}`,
      detail: [
        `Session: ${entry.title}`,
        `Project: ${project?.directory ?? 'unknown'}`,
        `Account reported by session: ${invocation.reportedAccount ?? 'not verified'}`,
        `Lifecycle: ${invocation.lifecycle} · ${freshness(invocation.observedAt)}`,
        'An active process is not proof of a logged-in account. No profile is assigned without evidence.',
        'This external session is observation-only; manage it in its native terminal.',
      ],
    });
  }
  return rows;
}
