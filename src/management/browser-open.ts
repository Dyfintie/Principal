import { createConnection } from 'node:net';
// Browser URLs are transient transport data, never logged or persisted.
const socketPath = process.env.PRINCIPAL_BROWSER_SOCKET;
if (!socketPath || process.argv.length !== 3) process.exitCode = 1;
else {
  const socket = createConnection(socketPath);
  const timer = setTimeout(() => {
    socket.destroy();
    process.exitCode = 1;
  }, 5000);
  let response = '';
  socket.on('connect', () => socket.write(JSON.stringify({ url: process.argv[2] }) + '\n'));
  socket.on('data', (data) => {
    response += data.toString();
    if (response.length > 1024) socket.destroy();
  });
  socket.on('error', () => {
    process.exitCode = 1;
  });
  socket.on('close', () => {
    clearTimeout(timer);
    try {
      if (JSON.parse(response).ok !== true) process.exitCode = 1;
    } catch {
      process.exitCode = 1;
    }
  });
}
