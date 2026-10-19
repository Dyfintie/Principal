const sensitive =
  /^(?:access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|authorization|client[-_]?secret|password|secret|token|session[-_]?token)$/i;
export function redactText(value) {
  return String(value)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/\b(?:Bearer\s+|ya29\.|sk-|1\/\/|AIzaSy|ghp_)[A-Za-z0-9._~-]+/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(
      /(\b(?:access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|authorization|client[-_]?secret|password|secret|token|session[-_]?token)\b["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,}]+)/gi,
      '$1[redacted]',
    );
}
export function redactValue(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitive.test(key) ? '[redacted]' : redactValue(item),
      ]),
    );
  return value;
}
export function redact(value) {
  if (typeof value !== 'string') {
    if (value instanceof Error) return redactText(value.message);
    return JSON.stringify(redactValue(value)) ?? String(value);
  }
  try {
    return JSON.stringify(redactValue(JSON.parse(value)));
  } catch {
    return redactText(value);
  }
}
