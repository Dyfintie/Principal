import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { defaultDirectory, findExecutable } from './providers.js';
import type { HandoffConstraints, Profile, Tool } from './model.js';
import { managementPaths } from './paths.js';

export interface AccountHandoffBundle {
  version: 1;
  tool: 'antigravity' | 'codex';
  label: string;
  accountHint: string;
  createdAt: string;
  encrypted: boolean;
  salt?: string;
  iv?: string;
  authTag?: string;
  payload: string;
  constraints?: HandoffConstraints;
}

export interface HandoffExportResult {
  bundle: AccountHandoffBundle;
  armoredToken: string;
  accountHint: string;
  constraints?: HandoffConstraints;
  savedPath?: string;
  copiedToClipboard: boolean;
}

export interface HandoffImportResult {
  tool: Tool;
  label: string;
  accountHint: string;
  profileId: string;
  directory: string;
  constraints?: HandoffConstraints;
}

/** Masks an email address or username for privacy while retaining a recognizable hint. */
export function maskEmail(emailOrUser: string): string {
  if (!emailOrUser) return 'account';
  if (emailOrUser.includes('@')) {
    const [user, domain] = emailOrUser.split('@');
    const maskedUser =
      user.length <= 2
        ? `${user[0]}*`
        : `${user[0]}***${user[user.length - 1]}`;
    return `${maskedUser}@${domain}`;
  }
  if (emailOrUser.length <= 4) return emailOrUser;
  return `${emailOrUser.slice(0, 2)}***${emailOrUser.slice(-2)}`;
}

/** Encrypts data string using AES-256-GCM with a key derived from the passphrase. */
export function encryptPayload(
  data: string,
  passphrase: string,
): { ciphertext: string; salt: string; iv: string; authTag: string } {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('base64'),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/** Decrypts AES-256-GCM ciphertext using the passphrase. */
export function decryptPayload(
  ciphertext: string,
  passphrase: string,
  saltB64: string,
  ivB64: string,
  authTagB64: string,
): string {
  const salt = Buffer.from(saltB64, 'base64');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const key = scryptSync(passphrase, salt, 32);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/** Safely extracts scoped credentials for a profile without touching passwords or cookies. */
export async function extractScopedCredentials(
  profile: Profile,
): Promise<{ tool: 'antigravity' | 'codex'; payload: any; emailHint: string }> {
  if (profile.tool === 'antigravity') {
    const candidateDirs = [
      profile.directory,
      path.join(managementPaths.profiles, profile.id, '.gemini', 'antigravity-cli'),
      path.join(managementPaths.profiles, profile.id),
      defaultDirectory('antigravity'),
    ];

    let tokenJsonStr: string | null = null;
    for (const dir of candidateDirs) {
      const tokenFile = path.join(dir, 'antigravity-oauth-token');
      try {
        const content = await readFile(tokenFile, 'utf8');
        if (content.trim().startsWith('{')) {
          tokenJsonStr = content.trim();
          break;
        }
      } catch {}
    }

    // Also check ~/.config/agy/profiles/<profile.label>.json
    if (!tokenJsonStr) {
      const home = process.env.HOME || '';
      const agyProfile = path.join(home, '.config', 'agy', 'profiles', `${profile.label}.json`);
      try {
        const content = await readFile(agyProfile, 'utf8');
        if (content.trim().startsWith('{')) tokenJsonStr = content.trim();
      } catch {}
    }

    if (!tokenJsonStr) {
      throw new Error(
        `No scoped OAuth token found for Antigravity profile '${profile.label}'. Ensure the profile has signed in at least once.`,
      );
    }

    let parsed: any;
    try {
      parsed = JSON.parse(tokenJsonStr);
    } catch {
      throw new Error('Antigravity credentials file is corrupted or not valid JSON.');
    }

    let emailHint = profile.reportedAccount || 'antigravity-account';
    if (parsed.id_token && typeof parsed.id_token === 'string') {
      try {
        const parts = parsed.id_token.split('.');
        if (parts.length >= 2) {
          let b64 = parts[1];
          b64 += '='.repeat((4 - (b64.length % 4)) % 4);
          const claims = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
          if (claims.email) emailHint = claims.email;
        }
      } catch {}
    }

    return {
      tool: 'antigravity',
      payload: parsed,
      emailHint: maskEmail(emailHint),
    };
  }

  if (profile.tool === 'codex') {
    const candidateDirs = [profile.directory, defaultDirectory('codex')];
    let authJsonStr: string | null = null;

    for (const dir of candidateDirs) {
      const authFile = path.join(dir, 'auth.json');
      try {
        const content = await readFile(authFile, 'utf8');
        if (content.trim().startsWith('{')) {
          authJsonStr = content.trim();
          break;
        }
      } catch {}
    }

    if (!authJsonStr) {
      throw new Error(
        `No credentials found for Codex profile '${profile.label}'. Check that auth.json exists.`,
      );
    }

    let parsed: any;
    try {
      parsed = JSON.parse(authJsonStr);
    } catch {
      throw new Error('Codex auth.json is corrupted or not valid JSON.');
    }

    const emailHint = profile.reportedAccount || 'codex-account';
    return {
      tool: 'codex',
      payload: parsed,
      emailHint: maskEmail(emailHint),
    };
  }

  throw new Error(`Account handoff is not supported for tool '${profile.tool}'. Supported tools: antigravity, codex.`);
}

/**
 * Parses duration strings like "4h", "2.5h", "30m", "1d", "48h", or plain numbers into hours.
 */
export function parseDurationToHours(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0)
      throw new Error('Time limit must be a positive number of hours');
    return input;
  }
  const trimmed = String(input).trim().toLowerCase();
  const match = trimmed.match(
    /^([\d.]+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|d|day|days)?$/,
  );
  if (!match) throw new Error(`Invalid duration format: "${input}". Use e.g. "4h", "30m", "1d"`);
  const val = parseFloat(match[1]);
  if (!Number.isFinite(val) || val <= 0) throw new Error('Time limit must be greater than zero');
  const unit = match[2] || 'h';
  if (unit.startsWith('m')) return Math.max(0.01, val / 60);
  if (unit.startsWith('d')) return val * 24;
  return val;
}

/** Packages scoped credentials into an exportable AccountHandoffBundle and armored token. */
export async function createHandoffBundle(
  profile: Profile,
  options?: {
    passphrase?: string;
    customLabel?: string;
    timeLimitHours?: number;
    expiresAt?: string;
    quotaLimitPercent?: number;
    baselineQuotaRemaining?: number;
    allowedQuotaFloor?: number;
  },
): Promise<{
  bundle: AccountHandoffBundle;
  armoredToken: string;
  emailHint: string;
  constraints?: HandoffConstraints;
}> {
  const { tool, payload, emailHint } = await extractScopedCredentials(profile);
  const label = options?.customLabel || profile.label || `${tool}-shared`;

  let constraints: HandoffConstraints | undefined;
  if (
    options?.timeLimitHours !== undefined ||
    options?.expiresAt ||
    options?.quotaLimitPercent !== undefined
  ) {
    const now = Date.now();
    const expiresAt =
      options.expiresAt ||
      (options.timeLimitHours !== undefined
        ? new Date(now + options.timeLimitHours * 3600 * 1000).toISOString()
        : undefined);

    let allowedQuotaFloor = options.allowedQuotaFloor;
    if (options.quotaLimitPercent !== undefined && allowedQuotaFloor === undefined) {
      const baseline = options.baselineQuotaRemaining ?? 100;
      allowedQuotaFloor = Math.max(0, baseline - options.quotaLimitPercent);
    }

    constraints = {
      timeLimitHours: options.timeLimitHours,
      expiresAt,
      quotaLimitPercent: options.quotaLimitPercent,
      baselineQuotaRemaining: options.baselineQuotaRemaining,
      allowedQuotaFloor,
      exportedAt: new Date(now).toISOString(),
      status: 'active',
    };
  }

  const wrappedPayload = {
    credentials: payload,
    constraints,
  };
  const payloadStr = JSON.stringify(wrappedPayload);

  let bundle: AccountHandoffBundle;
  if (options?.passphrase && options.passphrase.trim().length > 0) {
    const encrypted = encryptPayload(payloadStr, options.passphrase.trim());
    bundle = {
      version: 1,
      tool,
      label,
      accountHint: emailHint,
      createdAt: new Date().toISOString(),
      encrypted: true,
      salt: encrypted.salt,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      payload: encrypted.ciphertext,
      constraints,
    };
  } else {
    bundle = {
      version: 1,
      tool,
      label,
      accountHint: emailHint,
      createdAt: new Date().toISOString(),
      encrypted: false,
      payload: payloadStr,
      constraints,
    };
  }

  const armoredToken = `PRINCIPAL-HANDOFF:v1:${Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64')}`;
  return { bundle, armoredToken, emailHint, constraints };
}

/** Parses and decrypts an armored handoff token or raw JSON bundle string. */
export function parseAndValidateBundle(
  textOrArmored: string,
  passphrase?: string,
): { bundle: AccountHandoffBundle; credentialsPayload: any; constraints?: HandoffConstraints } {
  let jsonStr = textOrArmored.trim();
  if (jsonStr.startsWith('PRINCIPAL-HANDOFF:v1:')) {
    const b64 = jsonStr.slice('PRINCIPAL-HANDOFF:v1:'.length);
    jsonStr = Buffer.from(b64, 'base64').toString('utf8');
  }

  let bundle: AccountHandoffBundle;
  try {
    bundle = JSON.parse(jsonStr);
  } catch {
    throw new Error('Invalid handoff token or file format. Expected valid JSON or armored token.');
  }

  if (bundle.version !== 1 || !['antigravity', 'codex'].includes(bundle.tool)) {
    throw new Error('Unsupported handoff bundle version or tool.');
  }

  let payloadStr: string;
  if (bundle.encrypted) {
    if (!passphrase || !passphrase.trim()) {
      throw new Error(
        'This account handoff is encrypted with a passphrase. Please provide the passphrase.',
      );
    }
    if (!bundle.salt || !bundle.iv || !bundle.authTag) {
      throw new Error(
        'Encrypted bundle is missing cryptographic parameters (salt, iv, or authTag).',
      );
    }
    try {
      payloadStr = decryptPayload(
        bundle.payload,
        passphrase.trim(),
        bundle.salt,
        bundle.iv,
        bundle.authTag,
      );
    } catch {
      throw new Error('Failed to decrypt handoff bundle. Incorrect passphrase or corrupted data.');
    }
  } else {
    payloadStr = bundle.payload;
  }

  let credentialsPayload: any;
  let constraints: HandoffConstraints | undefined = bundle.constraints;
  try {
    const parsedObj = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr;
    if (parsedObj && typeof parsedObj === 'object' && 'credentials' in parsedObj) {
      credentialsPayload = parsedObj.credentials;
      if (parsedObj.constraints) {
        constraints = parsedObj.constraints;
      }
    } else {
      credentialsPayload = parsedObj;
    }
  } catch {
    throw new Error('Decrypted credentials payload is corrupted.');
  }

  return { bundle, credentialsPayload, constraints };
}

/** Copies text to the system clipboard (Wayland wl-copy or X11 xclip). */
export async function copyToClipboard(text: string): Promise<boolean> {
  const binary = (await findExecutable('wl-copy')) || (await findExecutable('xclip'));
  if (!binary) return false;

  return new Promise((resolve) => {
    const child = spawn(
      binary,
      binary.endsWith('xclip') ? ['-selection', 'clipboard'] : [],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    );
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
    child.stdin.write(text);
    child.stdin.end();
  });
}
