import { readFile } from 'node:fs/promises';

export function parseIdentity(text) {
  try {
    const stored = JSON.parse(text);
    const parts = stored.id_token.split('.');
    if (parts.length !== 3) throw new Error('Invalid identity token');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const identity = claims.email ?? claims.sub;
    if (typeof identity !== 'string' || !identity.trim()) throw new Error('Missing identity');
    return { identity, plan: null };
  } catch {
    throw new Error('Unable to read account identity; Antigravity credential format unsupported');
  }
}

export async function antigravityIdentity(capture) {
  let text;
  try {
    text = await readFile('/home/principal/.gemini/antigravity-cli/antigravity-oauth-token', 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    text = await capture('secret-tool', ['lookup', 'service', 'gemini', 'username', 'antigravity']);
  }
  return parseIdentity(text);
}
