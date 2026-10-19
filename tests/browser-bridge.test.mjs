import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startBrowserBridge, allowedLoginUrl } from '../dist/management/browser-bridge.js';
test('browser relay allows only Google login HTTPS URLs and restores the host environment without opening a real browser', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'principal-browser-'));
  const record = path.join(root, 'record.json');
  const opener = path.join(root, 'opener');
  await writeFile(
    opener,
    `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(record)},JSON.stringify({url:process.argv[2],bus:process.env.DBUS_SESSION_BUS_ADDRESS,home:process.env.HOME}));`,
    { mode: 0o700 },
  );
  const bridge = await startBrowserBridge(root, opener, {
    ...process.env,
    HOME: '/synthetic/host',
    DBUS_SESSION_BUS_ADDRESS: 'synthetic-host-bus',
  });
  async function open(url) {
    const child = spawn(path.join(bridge.bin, 'xdg-open'), [url], {
      env: {
        ...process.env,
        HOME: '/synthetic/private',
        DBUS_SESSION_BUS_ADDRESS: 'synthetic-private-bus',
        PRINCIPAL_BROWSER_SOCKET: bridge.socket,
      },
      stdio: 'ignore',
    });
    return (await once(child, 'exit'))[0];
  }
  try {
    assert.equal((await stat(bridge.socket)).mode & 0o777, 0o600);
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic';
    assert.equal(await open(url), 0);
    assert.deepEqual(JSON.parse(await readFile(record, 'utf8')), {
      url,
      bus: 'synthetic-host-bus',
      home: '/synthetic/host',
    });
    const previous = await readFile(record, 'utf8');
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://accounts.google.com.evil.test/',
      'https://accounts.google.com@evil.test/',
      'http://accounts.google.com/',
      'https://accounts.google.com:8443/',
      'https://example.test/',
      'https://accounts.google.com/\nfoo',
    ]) {
      assert.equal(allowedLoginUrl(url), false);
      assert.notEqual(await open(url), 0);
    }
    assert.equal(await readFile(record, 'utf8'), previous);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
