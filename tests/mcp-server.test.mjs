import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpRequest } from '../dist/mcp/server.js';

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
