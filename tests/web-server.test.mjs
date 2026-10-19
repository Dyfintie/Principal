import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startWebServer } from '../dist/management/web-server.js';

test('Principal Web Server - basic routing, CSRF protection, and RPC execution', async (t) => {
  // Start server on random ephemeral port
  const { url, server, close } = await startWebServer({ port: 0, host: '127.0.0.1', open: false });
  const bound = server.address();
  assert(typeof bound === 'object' && bound !== null);
  const port = bound.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await close();
  });

  // 1. GET / (Dashboard HTML)
  await t.test('serves modern dashboard HTML with security headers', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

    const html = await res.text();
    assert.match(html, /Principal · Agent Management Dashboard/);
    assert.match(html, /Live Sync/);
    assert.match(html, /Import Handoff/);
    assert.match(html, /Add Account/);
  });

  // 2. GET /api/health
  await t.test('health endpoint returns ok status', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.equal(data.version, '0.1.5');
  });

  // 3. GET /api/snapshot
  await t.test('snapshot endpoint returns valid system state', async () => {
    const res = await fetch(`${baseUrl}/api/snapshot`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert(Array.isArray(data.profiles));
    assert(Array.isArray(data.installations));
    assert(typeof data.activeProfiles === 'object');
  });

  // 4. CSRF Protection: POST /api/rpc without custom header
  await t.test('rejects RPC requests missing X-Principal-Request header with 403', async () => {
    const res = await fetch(`${baseUrl}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'snapshot' }),
    });
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.match(data.error, /Missing X-Principal-Request/);
  });

  // 5. CSRF-Protected POST /api/rpc with valid header
  await t.test('executes JSON-RPC methods when X-Principal-Request header is supplied', async () => {
    const res = await fetch(`${baseUrl}/api/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Principal-Request': '1',
      },
      body: JSON.stringify({ method: 'profiles.list' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert(Array.isArray(data.result));
    assert(data.result.length > 0);
  });

  // 6. GET /api/events (Server-Sent Events)
  await t.test('streams real-time updates via SSE', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/events`, {
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let received = '';

    while (!received.includes('data:')) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
      if (received.includes('data:')) {
        break;
      }
    }

    assert(received.includes(': connected') || received.includes('data:'));
    controller.abort();
  });
});
