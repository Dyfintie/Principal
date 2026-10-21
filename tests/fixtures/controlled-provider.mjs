#!/usr/bin/env node
// Credential-free native-protocol fixture. Never loads provider SDKs or networks.
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
if (process.argv.includes('--help')) {
  const help = 'app-server --model --conversation --input-format stream-json --output-format stream-json --effort low|medium|high|xhigh|max --no-auto-update --output-format --reasoning-effort';
  if (process.argv[1].endsWith('-stderr')) console.error(help);
  else console.log(help);
  process.exit(0);
}
if (process.argv.includes('--version')) { console.log('0.163.0'); process.exit(0); }
const copilot = process.argv.includes('--headless');
const agy = process.argv.includes('--input-format');
const send = (value) => {
  const body = JSON.stringify(copilot ? { jsonrpc: '2.0', ...value } : value);
  const wire = copilot ? Buffer.from('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body) : body + '\n';
  // Fragment headers and multibyte Unicode payloads across chunks.
  if (copilot) { process.stdout.write(wire.subarray(0, 17)); process.stdout.write(wire.subarray(17)); }
  else process.stdout.write(wire);
};
let session = agy ? 'agy-fixture-session' : 'codex-fixture-session';
let turn = 0;
let active;
if (agy) send({ event: 'init', conversation_id: session, init: { model: 'fixture-model' } });
function completed(status = 'completed') {
  if (agy) send({ event: 'result', result: { conversation_id: session, status: status === 'completed' ? 'SUCCESS' : 'ERROR', ...(status === 'completed' ? {} : { error: '401 authentication required private-token-must-not-persist' }) } });
  else send({ method: 'turn/completed', params: { turn: { id: active, status, ...(status === 'completed' ? {} : { error: { message: '429 quota exceeded private-token-must-not-persist' } }) } } });
}
function run(message) {
  appendFileSync('received.txt', message + '\n');
  if (message === 'large-output') {
    send({ method: 'item/agentMessage/delta', params: { delta: 'z'.repeat(140000) + 'THE_END' } });
    completed(); return;
  }
  if (message === 'result-only') {
    send({ event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: 'A complete final response without deltas.' } });
    return;
  }
  if (message === 'malformed') { process.stdout.write('not-json\n'); return; }
  if (message === 'exit-zero') { process.exit(0); }
  if (message === 'fail') { completed('failed'); return; }
  if (message === 'spawn-hang') {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
    writeFileSync('descendant.pid', String(child.pid));
    return;
  }
  if (message === 'hang') { setInterval(() => {}, 1000); return; }
  writeFileSync('answer.txt', message + '\n');
  if (agy) send({ event: 'step_update', step_update: { step_index: turn, state: 'DONE', step_type: 'agent_response', text_delta: 'working\n' } });
  else send({ method: 'item/agentMessage/delta', params: { delta: 'working\n' } });
  setTimeout(() => completed(), 30);
}
if (copilot) {
  let buffer = Buffer.alloc(0);
  const event = (type, data = {}, sessionId = session) => send({ method: 'session.event', params: { sessionId, event: { type, data } } });
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const length = Number(buffer.subarray(0, end).toString().split(':')[1].trim());
      if (buffer.length < end + 4 + length) return;
      const request = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
      buffer = buffer.subarray(end + 4 + length);
      const result = (value) => send({ id: request.id, result: value });
      const p = request.params;
      if (request.method === 'ping') { result({ protocolVersion: process.argv[1].endsWith('-protocol4') ? 4 : 3 }); continue; }
      if (['session.create', 'session.resume'].includes(request.method)) {
        if (!p.workingDirectory || !p.streaming || !p.requestPermission || p.requestUserInput !== false) {
          send({ id: request.id, error: { message: 'Invalid session configuration' } }); continue;
        }
        if (p.model === 'invalid-model') { send({ id: request.id, error: { message: 'unsupported model' } }); continue; }
        session = p.sessionId;
        writeFileSync('session-options.json', JSON.stringify({ model: p.model, reasoningEffort: p.reasoningEffort }));
        result({ sessionId: session }); continue;
      }
      if (request.method === 'session.send') {
        if (p.sessionId !== session || p.mode !== 'enqueue') { send({ id: request.id, error: { message: 'Invalid session send' } }); continue; }
        appendFileSync('received.txt', p.prompt + '\n');
        result({ messageId: 'copilot-message-' + (++turn) });
        if (p.prompt === 'hang') { setInterval(() => {}, 1000); continue; }
        if (p.prompt === 'bad-frame') { process.stdout.write('Content-Length: 2000000\r\n\r\n'); continue; }
        if (p.prompt === 'fail') { event('session.error', { message: '401 authentication private-token-must-not-persist' }); event('session.idle'); continue; }
        event('session.idle', {}, 'unrelated-session');
        if (p.prompt === 'permission') {
          event('permission.requested', { requestId: 'tool-permission', permissionRequest: { kind: 'write', privateValue: 'must-not-persist' } }); continue;
        }
        writeFileSync('answer.txt', p.prompt + '\n');
        event('assistant.message_delta', { deltaContent: 'working λ🙂\n' });
        event('assistant.reasoning_delta', { deltaContent: 'private-reasoning-must-not-persist' });
        event('assistant.message', { content: 'Complete answer λ🙂' });
        event('assistant.turn_end');
        setTimeout(() => event('session.idle'), 30); continue;
      }
      if (request.method === 'session.permissions.handlePendingPermissionRequest') {
        if (p.sessionId !== session || p.requestId !== 'tool-permission' || p.result?.kind !== 'approve-once') process.exit(2);
        result({}); writeFileSync('permission.txt', 'approved');
        event('assistant.message', { content: 'Allowed tool completed' });
        event('session.idle'); continue;
      }
      if (request.method === 'session.abort') { result({}); event('session.idle', { aborted: true }); continue; }
      send({ id: request.id, error: { message: 'Unsupported SDK request' } });
    }
  });
} else createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (agy) { turn++; run(request.message.content); return; }
  const result = (value) => send({ id: request.id, result: value });
  if (['turn/start', 'turn/steer'].includes(request.method) && (!Array.isArray(request.params.input?.[0]?.text_elements) || !request.params.clientUserMessageId)) {
    send({ id: request.id, error: { message: 'Invalid native turn input shape' } }); return;
  }
  switch (request.method) {
    case 'initialize': result({ capabilities: {} }); break;
    case 'initialized': break;
    case 'thread/start':
    case 'thread/resume':
      if (request.params.model === 'invalid-model') send({ id: request.id, error: { message: 'unsupported model' } });
      else result({ thread: { id: request.params.threadId ?? session }, model: 'fixture-model' });
      break;
    case 'turn/start':
      active = 'native-turn-' + (++turn);
      result({ turn: { id: active } });
      send({ method: 'turn/started', params: { turn: { id: active } } });
      run(request.params.input[0].text);
      break;
    case 'turn/steer':
      if (request.params.input[0].text === 'no-ack') break;
      if (request.params.expectedTurnId !== active) send({ id: request.id, error: { message: 'active turn changed' } });
      else { result({ turnId: active }); run(request.params.input[0].text); }
      break;
    case 'turn/interrupt': result({}); completed('interrupted'); break;
    default: result({});
  }
});
