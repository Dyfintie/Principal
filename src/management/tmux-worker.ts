import { createConnection } from 'node:net';
// One profile's environment is transferred in memory over a private socket.
const socket = createConnection(process.argv[2]);
let body = '',
  started = false;
const timeout = setTimeout(() => {
  socket.destroy();
  process.exitCode = 1;
}, 10_000);
socket.on('error', () => {
  clearTimeout(timeout);
  process.exitCode = 1;
});
socket.on('data', (chunk) => {
  if (started) return;
  body += chunk.toString();
  if (Buffer.byteLength(body) > 2 * 1024 * 1024) {
    socket.destroy();
    return;
  }
  if (!body.includes('\n')) return;
  started = true;
  clearTimeout(timeout);
  void (async () => {
    const request = JSON.parse(body);
    body = '';
    const terminalEnv = {
      TERM: process.env.TERM,
      TMUX: process.env.TMUX,
      TMUX_PANE: process.env.TMUX_PANE,
    };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, request.env, terminalEnv);
    delete request.env;
    // State paths are module constants: resolve them only after this caller's
    // environment replaces the shared tmux server's sanitized environment.
    const { launchAgent } = await import('./launcher.js');
    process.exitCode = await launchAgent(request.options, (id) => {
      socket.end(JSON.stringify({ id }) + '\n');
    });
  })().catch(() => {
    socket.end('{"error":true}\n');
    console.error('Native launch failed. Check profile authentication and workspace in Principal.');
    process.exitCode = 1;
  });
});
