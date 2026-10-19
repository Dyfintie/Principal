import test from 'node:test';
import assert from 'node:assert/strict';
import { nextAccountLabel, enrollAccount } from '../dist/account-enrollment.js';
import { ConfigSchema } from '../dist/schema.js';
const config = ConfigSchema.parse({});
function fixture(provider, statuses = [{ state: 'completed' }], accounts = []) {
  const calls = [],
    progress = [],
    browser = [];
  const account = {
    id: 'new',
    label: provider + '-1',
    provider,
    status: 'ready',
    identity: 'test@example.com',
  };
  const deps = {
    request: async (method, args) => {
      calls.push({ method, args });
      if (method === 'accounts.list') return accounts;
      if (method === 'accounts.begin')
        return {
          account,
          owner: 'owner',
          container: 'container',
          login: { verificationUrl: 'https://example.com/signin', userCode: 'ABCD' },
        };
      if (method === 'accounts.loginStatus') return statuses.shift() ?? { state: 'completed' };
      if (method === 'accounts.finish') return args.abort ? { aborted: true } : account;
      throw new Error(method);
    },
    antigravity: async (container) => calls.push({ method: 'native-login', args: container }),
    wait: async () => {},
    openBrowser: (url) => browser.push(url),
  };
  return {
    deps,
    calls,
    progress,
    browser,
    account,
    options: { config, progress: (text) => progress.push(text) },
  };
}
test('account labels are automatic and do not collide across providers', () => {
  assert.equal(nextAccountLabel('codex', [{ label: 'codex-1' }, { label: 'codex-3' }]), 'codex-2');
  assert.equal(nextAccountLabel('antigravity', [{ label: 'codex-1' }]), 'antigravity-1');
});
test('Codex enrollment opens the browser, waits for completion, and finalizes once', async () => {
  const f = fixture('codex', [{ state: 'pending' }, { state: 'completed' }]);
  assert.equal(await enrollAccount('codex', f.options, f.deps), f.account);
  assert.deepEqual(f.browser, ['https://example.com/signin']);
  assert.ok(f.progress.some((text) => text.includes('ABCD')));
  assert.equal(f.calls.filter((c) => c.method === 'accounts.finish').length, 1);
  assert.equal(f.calls.find((c) => c.method === 'accounts.begin').args.label, 'codex-1');
});
test('Antigravity enrollment uses the native login terminal without Codex polling', async () => {
  const f = fixture('antigravity');
  await enrollAccount('antigravity', f.options, f.deps);
  assert.ok(f.calls.some((c) => c.method === 'native-login' && c.args === 'container'));
  assert.ok(!f.calls.some((c) => c.method === 'accounts.loginStatus'));
});
test('failed and cancelled sign-in abort leases instead of reporting success', async () => {
  for (const cancel of [false, true]) {
    const f = fixture('codex', [{ state: 'failed', error: 'Denied sign-in' }]);
    if (cancel)
      f.deps.wait = async () => {
        process.emit('SIGINT');
      };
    const before = process.listenerCount('SIGINT');
    await assert.rejects(
      enrollAccount('codex', f.options, f.deps),
      cancel ? /cancelled/ : /Denied/,
    );
    assert.ok(f.calls.some((c) => c.method === 'accounts.finish' && c.args.abort));
    assert.equal(process.listenerCount('SIGINT'), before);
  }
});
test('unidentified cancelled accounts are reused; registered labels do not start another login', async () => {
  const f = fixture('codex', undefined, [
    { label: 'codex-1', provider: 'codex', status: 'auth_required', identity: null },
  ]);
  await enrollAccount('codex', f.options, f.deps);
  assert.equal(f.calls.find((c) => c.method === 'accounts.begin').args.reauth, true);
  const ready = fixture('codex', undefined, [
    { label: 'mine', provider: 'codex', status: 'ready', identity: 'someone' },
  ]);
  await assert.rejects(
    enrollAccount('codex', { ...ready.options, label: 'mine' }, ready.deps),
    /already registered/,
  );
  assert.ok(!ready.calls.some((c) => c.method === 'accounts.begin'));
});

test('cancellation during container startup aborts the admitted login and removes its handler', async () => {
  const f = fixture('codex');
  const request = f.deps.request;
  f.deps.request = async (method, args) => {
    const result = await request(method, args);
    if (method === 'accounts.begin') process.emit('SIGINT');
    return result;
  };
  const before = process.listenerCount('SIGINT');
  await assert.rejects(enrollAccount('codex', f.options, f.deps), /cancelled/);
  assert.ok(f.calls.some((c) => c.method === 'accounts.finish' && c.args.abort));
  assert.equal(process.listenerCount('SIGINT'), before);
});

test('Antigravity native sign-in failure cleans up without finalizing an account', async () => {
  const f = fixture('antigravity');
  f.deps.antigravity = async () => {
    throw new Error('Native sign-in declined');
  };
  await assert.rejects(enrollAccount('antigravity', f.options, f.deps), /declined/);
  assert.ok(f.calls.some((c) => c.method === 'accounts.finish' && c.args.abort));
  assert.ok(!f.calls.some((c) => c.method === 'accounts.finish' && !c.args.abort));
});
