import { ancestors } from './process.js';
import { Tool } from './model.js';
import { normalizeClaudeHook, normalizeStatusline } from './observations.js';
import { sendManagement } from './client.js';

export async function collectCallback(tool: string, hook = false) {
  let body = '';
  const timer = setTimeout(() => process.stdin.destroy(), 1500);
  try {
    for await (const chunk of process.stdin) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 128 * 1024) throw new Error('Statusline exceeds limit');
    }
    clearTimeout(timer);
    const parsed = Tool.parse(tool);
    if (hook && parsed !== 'claude') throw new Error('No hook parser for this tool');
    const parents = await ancestors(process.pid);
    const value = hook
      ? normalizeClaudeHook(JSON.parse(body), parents, process.env.PRINCIPAL_INVOCATION_ID)
      : normalizeStatusline(parsed, JSON.parse(body), parents, process.env.PRINCIPAL_INVOCATION_ID);
    await sendManagement('observe', value, 1000, process.env.PRINCIPAL_MANAGEMENT_SOCKET);
    if (!hook) console.log(`Principal · ${parsed} · observation recorded`);
  } catch (error) {
    // A statusline helper cannot block authentication or interfere with agent work.
    if (!hook) {
      const message = error instanceof Error ? error.message : '';
      const reason = message.includes('associated with the live native process')
        ? 'process-mismatch'
        : message.includes('Unknown invocation')
          ? 'invocation-missing'
          : message.includes('verified native process ancestor')
            ? 'ancestor-missing'
            : message.includes('disabled for this tool version')
              ? 'unsupported-version'
              : message.includes('timed out')
                ? 'timeout'
                : message.includes('ENOENT')
                  ? 'socket-missing'
                  : message.includes('exceeds')
                    ? 'payload-size'
                    : error instanceof SyntaxError
                      ? 'invalid-json'
                      : error instanceof Error && error.name === 'ZodError'
                        ? 'invalid-payload'
                        : 'observation-rejected';
      console.log(
        `Principal · observation unavailable${process.env.PRINCIPAL_OBSERVER_DIAGNOSTICS === '1' ? ` [${reason}]` : ''}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
if (process.argv[1]?.endsWith('/management/callback.js'))
  await collectCallback(process.argv[2] ?? '', process.argv[3] === 'hook');
