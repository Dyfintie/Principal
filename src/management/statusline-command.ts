import { fileURLToPath } from 'node:url';
const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
export function nativeStatuslineCommand(tool: 'claude' | 'antigravity') {
  const callback = fileURLToPath(new URL('./callback.js', import.meta.url));
  return `${shellQuote(process.execPath)} ${shellQuote(callback)} ${tool}`;
}
