import { connect } from 'node:net';
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const socket = connect('/run/principal/helper.sock');
socket.on('connect', () => socket.end(Buffer.concat(chunks)));
socket.on('data', (b) => process.stdout.write(b));
socket.on('error', (e) => {
  console.error(e.message);
  process.exitCode = 1;
});
