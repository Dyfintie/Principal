import { rpc, resetConnection } from './client.js';
import { Runtime } from './runtime.js';
import type { NativeSession } from './native.js';
import { terminalInputOff } from './chat-scroll.js';
export async function openNative(args: Record<string, unknown>, dependencies = {
  request: rpc,
  launch: (session: NativeSession) => new Runtime().nativeInterface(session.container, session.provider, session.model, session.workingDirectory),
  notice: (text: string) => console.log(text),
}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Native mode requires an interactive terminal');
  const protocol = await dependencies.request('protocol', {});
  if (!protocol.native || !protocol.nativeWorkingDirectory) throw new Error('Restart the Principal coordinator after active work settles to enable native mode');
  dependencies.notice('Opening native mode…');
  const session: NativeSession = await dependencies.request('native.open', args);
  let closing: Promise<unknown> | undefined;
  const close = () => closing ??= dependencies.request('native.close', { owner: session.owner });
  const ignoreInterrupt = () => {}; // The native foreground interface receives Ctrl+C itself.
  const terminate = () => { void close().catch(() => {}).finally(() => { process.stdout.write(terminalInputOff + '\x1b[?25h'); process.exit(143); }); };
  const hangup = () => { void close().catch(() => {}).finally(() => { process.stdout.write(terminalInputOff + '\x1b[?25h'); process.exit(129); }); };
  process.on('SIGINT', ignoreInterrupt);
  process.once('SIGTERM', terminate);
  process.once('SIGHUP', hangup);
  let renewal: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (!renewal) renewal = dependencies.request('native.heartbeat', { owner: session.owner }).catch((error) => {
      if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(error.code)) resetConnection();
      else dependencies.notice(`Native attachment: ${error.message}`);
    }).finally(() => { renewal = undefined; });
  }, 10000);
  try {
    process.stdout.write(terminalInputOff + '\x1b[?25h');
    dependencies.notice(`Native mode · Pool: ${session.pool ?? args.pool ?? 'selected'} · ${session.provider} · Account: ${session.label}\nDirectory: ${session.directory}\nThis interface edits this directory directly. Exit the provider to return to Principal.`);
    await dependencies.launch(session);
  } finally {
    clearInterval(timer);
    try {
      await renewal;
      dependencies.notice('Saving native account state…');
      await close();
    } finally {
      process.removeListener('SIGINT', ignoreInterrupt);
      process.removeListener('SIGTERM', terminate);
      process.removeListener('SIGHUP', hangup);
      process.stdout.write(terminalInputOff + '\x1b[?25h');
    }
  }
}
