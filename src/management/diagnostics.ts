import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { exec } from '../util.js';
import { findExecutable } from './providers.js';
import type { Installation, Profile } from './model.js';

export interface DiagnosticsReport {
  checkedAt: string;
  tools: Installation[];
  isolation: {
    dependencies: Record<string, boolean>;
    secretService: 'unlocked' | 'locked' | 'unavailable' | 'unknown';
  };
  profiles: {
    id: string;
    label: string;
    tool: string;
    status: 'Healthy' | 'Unauthorized' | 'Unreachable' | 'Not Verified';
    reason: string;
    checkedAt: string | null;
    credential: 'expired' | 'not-expired' | 'not-applicable' | 'unverified';
  }[];
}

/** Local expiry evidence is not evidence of server acceptance. Never return token contents. */
export async function credentialExpiry(
  profile: Profile,
): Promise<DiagnosticsReport['profiles'][number]['credential']> {
  if (profile.tool !== 'codex') return 'unverified';
  try {
    const file = path.join(profile.directory, 'auth.json');
    const meta = await lstat(file);
    if (
      !meta.isFile() ||
      meta.isSymbolicLink() ||
      meta.uid !== process.getuid?.() ||
      meta.size > 65536
    )
      return 'unverified';
    const value = JSON.parse(await readFile(file, 'utf8'));
    const token = value.tokens?.access_token;
    if (!token && value.OPENAI_API_KEY) return 'not-applicable';
    if (typeof token !== 'string') return 'unverified';
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp * 1000 <= Date.now()
        ? 'expired'
        : 'not-expired'
      : 'unverified';
  } catch {
    return 'unverified';
  }
}

export async function isolationHealth(): Promise<DiagnosticsReport['isolation']> {
  const names = ['dbus-daemon', 'gnome-keyring-daemon', 'gdbus', 'secret-tool'];
  const binaries = await Promise.all(names.map(findExecutable));
  const dependencies = Object.fromEntries(names.map((name, i) => [name, !!binaries[i]]));
  const gdbus = binaries[2];
  if (!gdbus) return { dependencies, secretService: 'unavailable' };
  try {
    const result = await exec(
      gdbus,
      [
        'call',
        '--session',
        '--dest',
        'org.freedesktop.secrets',
        '--object-path',
        '/org/freedesktop/secrets/collection/login',
        '--method',
        'org.freedesktop.DBus.Properties.Get',
        'org.freedesktop.Secret.Collection',
        'Locked',
      ],
      { timeout: 3000, maxBytes: 4096, allowFailure: true },
    );
    return {
      dependencies,
      secretService:
        result.code !== 0
          ? 'unknown'
          : result.stdout.toString().includes('false')
            ? 'unlocked'
            : result.stdout.toString().includes('true')
              ? 'locked'
              : 'unknown',
    };
  } catch {
    return { dependencies, secretService: 'unknown' };
  }
}
