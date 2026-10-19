import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat } from 'node:fs/promises';
import type { Installation, Profile } from './model.js';
import { isolatedAntigravityLaunch } from './antigravity-isolation.js';
import { managementPaths } from './paths.js';

export interface AntigravityProbeBucket {
  bucket: string;
  value: number;
  resetsAt: string | null;
}

export function parseResetTimestamp(raw?: string | null): string | null {
  if (!raw || raw.trim() === '--') return null;
  const clean = raw.trim();
  const d = Date.parse(clean);
  if (Number.isFinite(d)) return new Date(d).toISOString();
  const match = clean.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})(?:\s+([A-Z]{3,4}))?$/);
  if (match) {
    const tz = match[3] === 'IST' ? '+05:30' : match[3] === 'UTC' ? 'Z' : '';
    const parsed = Date.parse(`${match[1]}T${match[2]}:00${tz}`);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

export function parseAntigravityUsageStdout(stdout: string): AntigravityProbeBucket[] {
  const buckets: AntigravityProbeBucket[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.includes('%')) continue;
    const parts = line.trim().split(/\s{2,}|\t+/);
    if (parts.length >= 3) {
      const [category, limitType, pct, resetStr] = parts;
      const cat = category.toLowerCase();
      const lim = limitType.toLowerCase();
      if (!lim.includes('week')) continue;
      let bucket: string | null = null;
      if (cat.includes('gemini')) {
        bucket = 'gemini-weekly';
      } else if (cat.includes('claude') || cat.includes('gpt') || cat.includes('3p')) {
        bucket = '3p-weekly';
      }
      if (bucket) {
        const val = parseFloat(pct.replace('%', ''));
        if (Number.isFinite(val) && val >= 0 && val <= 100) {
          buckets.push({
            bucket,
            value: val,
            resetsAt: parseResetTimestamp(resetStr),
          });
        }
      }
    }
  }
  return buckets;
}

export async function probeAntigravity(
  profile: Profile,
  installation: Installation,
): Promise<{ buckets: AntigravityProbeBucket[]; account?: string } | null> {
  if (
    !installation.executable ||
    installation.version === 'fixture' ||
    !installation.capabilities.observer?.supported
  ) {
    return null;
  }

  try {
    const s = await lstat(installation.executable);
    if (!s.isFile()) return null;
  } catch {
    return null;
  }

  if (!profile.isolated) {
    return null;
  }

  try {
    const spec = {
      executable: installation.executable,
      args: ['-p', '/usage'],
      env: {
        ...process.env,
        PRINCIPAL_MANAGEMENT_SOCKET: managementPaths.socket,
      },
    };
    const launch = await isolatedAntigravityLaunch(profile, spec);
    let child: ReturnType<typeof spawn> | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      child = spawn(launch.executable, [...launch.args], {
        env: launch.env,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
      });

      if (launch.keyringPassword && child.stdio[3]) {
        (child.stdio[3] as import('node:stream').Writable).end(launch.keyringPassword);
      }

      let stdout = '';
      child.stdout?.on('data', (d) => {
        stdout += d.toString();
      });

      const exitPromise = once(child, 'exit');
      timer = setTimeout(() => {
        try {
          child?.kill('SIGTERM');
          setTimeout(() => {
            try { child?.kill('SIGKILL'); } catch {}
          }, 1500).unref();
        } catch {}
      }, 15_000);

      const [exitCode] = (await exitPromise) as [number | null];
      clearTimeout(timer);

      if (exitCode !== 0) return null;
      const buckets = parseAntigravityUsageStdout(stdout);
      if (!buckets.length) return null;
      return { buckets, account: profile.reportedAccount ?? undefined };
    } finally {
      if (timer) clearTimeout(timer);
      if (launch.cleanup) {
        await launch.cleanup().catch(() => {});
      }
    }
  } catch {
    return null;
  }
}
