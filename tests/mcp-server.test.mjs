import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpRequest } from '../dist/mcp/server.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

test('MCP server responds to initialize and advertises tools capability', async () => {
  const req = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'codex', version: '0.1.0' },
    },
  };

  const res = await handleMcpRequest(req);
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, '2024-11-05');
  assert.deepEqual(res.result.capabilities, { tools: {} });
  assert.equal(res.result.serverInfo.name, 'principal-swarm');
});

test('MCP server tools/list returns swarm tools and schemas', async () => {
  const req = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  };

  const res = await handleMcpRequest(req);
  assert.equal(res.id, 2);
  const toolNames = res.result.tools.map((t) => t.name);
  assert.ok(toolNames.includes('principal_deploy_swarm'));
  assert.ok(toolNames.includes('principal_get_swarm_status'));
  assert.ok(toolNames.includes('principal_cancel_swarm'));
  assert.ok(toolNames.includes('principal_list_profiles'));
  assert.ok(toolNames.includes('principal_start_worker'));
  assert.ok(toolNames.includes('principal_send_worker_message'));
  assert.ok(toolNames.includes('principal_resume_worker'));
  const start = res.result.tools.find((t) => t.name === 'principal_start_worker');
  assert.ok(start.inputSchema.required.includes('profile_id'));
  assert.ok(start.inputSchema.required.includes('request_id'));
});

test('MCP validates explicit assignments before invoking management', async () => {
  let called = false;
  const dispatch = async () => { called = true; };
  const response = await handleMcpRequest({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'principal_start_worker', arguments: { task: 'implicit' } } }, dispatch);
  assert.equal(response.result.isError, true);
  assert.equal(called, false);
  const success = await handleMcpRequest({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'principal_start_worker', arguments: { request_id: 'exact', profile_id: 'profile', cwd: '/repo', task: 'work' } } }, async (method, args) => {
    assert.equal(method, 'workers.start'); assert.equal(args.profile_id, 'profile'); return { workerId: 'durable-worker' };
  });
  assert.equal(JSON.parse(success.result.content[0].text).workerId, 'durable-worker');
});

test('stdio polling does not block ping and cancellation aborts only its request', async (t) => {
  const url = new URL('../dist/mcp/server.js', import.meta.url).href;
  const program = `import {startMcpStdioServer} from ${JSON.stringify(url)};
    startMcpStdioServer(async (method, args, signal) => {
      if (method === 'workers.get') await new Promise((resolve,reject) => {
        const timer=setTimeout(resolve,2000);
        signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('cancelled'));},{once:true});
      });
      return {method};
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGTERM'); });
  const responses = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => { const value = JSON.parse(line); responses.set(value.id, value); });
  const send = (value) => child.stdin.write(JSON.stringify(value) + '\n');
  const wait = async (id) => {
    const end = Date.now() + 1500;
    while (!responses.has(id) && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    assert.ok(responses.has(id), 'response ' + id + ' blocked behind polling');
  };
  send({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'principal_get_worker', arguments: { worker_id: randomUUID(), wait_seconds: 25 } } });
  send({ jsonrpc: '2.0', id: 101, method: 'ping' });
  await wait(101);
  assert.equal(responses.has(100), false);
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 100 } });
  send({ jsonrpc: '2.0', id: 102, method: 'ping' });
  await wait(102);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(responses.has(100), false);
  child.stdin.end();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Cancelled poll kept stdio server alive')), 1000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
});

test('MCP server ping returns empty result', async () => {
  const req = {
    jsonrpc: '2.0',
    id: 'ping-1',
    method: 'ping',
  };

  const res = await handleMcpRequest(req);
  assert.deepEqual(res, { jsonrpc: '2.0', id: 'ping-1', result: {} });
});

test('MCP server handles unknown method gracefully with code -32601', async () => {
  const req = {
    jsonrpc: '2.0',
    id: 99,
    method: 'non_existent_method',
  };

  const res = await handleMcpRequest(req);
  assert.equal(res.id, 99);
  assert.equal(res.error.code, -32601);
  assert.match(res.error.message, /Method not found/);
});

test('MCP server notification returns null without throwing', async () => {
  const req = {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  };

  const res = await handleMcpRequest(req);
  assert.equal(res, null);
});
