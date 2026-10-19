import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { findExecutable, detectInstallation } from '../dist/management/providers.js';
import { runNative } from '../dist/management/launcher.js';
import { forceStopOwned, processIdentity } from '../dist/management/process.js';
const dependencies = await Promise.all(
  ['dbus-daemon', 'gnome-keyring-daemon', 'secret-tool', 'gdbus'].map(findExecutable),
);

test(
  'private Antigravity runtimes isolate simultaneous secrets and persist encrypted keyrings across restarts',
  { skip: process.platform !== 'linux' || dependencies.some((d) => !d), timeout: 45_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'principal-isolation-test-'));
    const fixture = path.join(root, 'native.mjs');
    await writeFile(
      fixture,
      `import {spawnSync} from 'node:child_process';
if(process.argv[2]==='store'){ const r=spawnSync(${JSON.stringify(dependencies[2])},['store','--label=Synthetic isolation test','application','principal-isolation-test'],{input:process.argv[3],timeout:5000}); if(r.status!==0)process.exit(2); }
const r=spawnSync(${JSON.stringify(dependencies[2])},['lookup','application','principal-isolation-test'],{timeout:5000});
if(r.status!==0 || r.stdout.toString().trim()!==process.argv[3])process.exit(3);
if(process.argv[2].startsWith('wait')){if(process.argv[2]==='wait-force')process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
`,
    );
    async function run(home, password, mode, value) {
      const runtime = await mkdtemp(path.join(tmpdir(), 'principal-agy-'));
      let nativePid;
      const code = await runNative(
        {
          executable: process.execPath,
          args: [
            path.resolve('dist/management/antigravity-isolation.js'),
            process.execPath,
            fixture,
            mode,
            value,
          ],
          env: {
            ...process.env,
            HOME: home,
            XDG_DATA_HOME: path.join(home, '.local/share'),
            XDG_CONFIG_HOME: path.join(home, '.config'),
            XDG_STATE_HOME: path.join(home, '.local/state'),
            XDG_CACHE_HOME: path.join(home, '.cache'),
            XDG_RUNTIME_DIR: runtime,
          },
          keyringPassword: Buffer.from(password),
          trackNativePid: true,
        },
        root,
        async (pid) => {
          nativePid = pid;
          if (mode === 'wait-force') {
            await new Promise((r) => setTimeout(r, 200));
            await forceStopOwned(await processIdentity(pid), await processIdentity(process.pid));
          }
        },
        mode === 'wait' ? async () => 'synthetic-stop-request' : undefined,
      );
      assert.equal(code, mode === 'wait' ? 143 : mode === 'wait-force' ? 137 : 0);
      assert.ok(nativePid > 1);
      await assert.rejects(stat(runtime), { code: 'ENOENT' });
      assert.throws(() => process.kill(nativePid, 0), { code: 'ESRCH' });
    }
    try {
      const a = path.join(root, 'a'),
        b = path.join(root, 'b'),
        pa = randomBytes(32).toString('base64'),
        pb = randomBytes(32).toString('base64');
      await Promise.all([run(a, pa, 'store', 'SYNTHETIC-A'), run(b, pb, 'store', 'SYNTHETIC-B')]);
      await Promise.all([run(a, pa, 'lookup', 'SYNTHETIC-A'), run(b, pb, 'lookup', 'SYNTHETIC-B')]);
      await Promise.all([run(a, pa, 'wait', 'SYNTHETIC-A'), run(b, pb, 'lookup', 'SYNTHETIC-B')]);
      await run(a, pa, 'wait-force', 'SYNTHETIC-A');
      await run(a, pa, 'lookup', 'SYNTHETIC-A');
      for (const [home, password] of [
        [a, pa],
        [b, pb],
      ]) {
        const file = path.join(home, '.local/share/keyrings/login.keyring');
        const bytes = await readFile(file);
        assert.equal(bytes.includes(Buffer.from(password)), false);
        assert.equal(bytes.includes(Buffer.from('SYNTHETIC-')), false);
        assert.equal((await stat(file)).mode & 0o077, 0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('Antigravity capability checks tolerate future versions and disable only missing resume support', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'principal-agy-capability-'));
  const previous = process.env.PATH;
  try {
    process.env.PATH = root;
    for (const [version, help, code] of [
      ['1.3.99', '  --conversation ID', 0],
      ['2.0.0', '  --conversation=ID', 0],
      ['2.0.1', '  --help', 0],
      ['2.0.2', '  --conversation ID', 1],
    ]) {
      await writeFile(
        path.join(root, 'agy'),
        `#!${process.execPath}\nif(process.argv.includes('--version')) console.log(${JSON.stringify(version)});else {console.log(${JSON.stringify(help)});process.exit(${code});}\n`,
        { mode: 0o700 },
      );
      const installed = await detectInstallation('antigravity');
      assert.equal(installed.capabilities.launch.supported, true);
      assert.equal(installed.capabilities.observer.supported, true);
      assert.equal(installed.capabilities.observer.confidence, 'unverified');
      assert.equal(
        installed.capabilities.resume.supported,
        code === 0 && help.includes('--conversation'),
      );
      assert.equal(installed.capabilities.configurationIsolation.supported, false);
    }
  } finally {
    process.env.PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'isolated native callbacks reach the host socket despite private HOME and XDG state',
  { skip: process.platform !== 'linux' || dependencies.some((d) => !d), timeout: 20_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'principal-isolated-callback-'));
    const socket = path.join(root, 'manager.sock');
    let received;
    const server = createServer((connection) => {
      let body = '';
      connection.on('data', (chunk) => {
        body += chunk.toString();
        if (!body.includes('\n')) return;
        received = JSON.parse(body.trim());
        connection.end(JSON.stringify({ protocolVersion: 1, result: { accepted: true } }) + '\n');
      });
    });
    server.listen(socket);
    await once(server, 'listening');
    await chmod(socket, 0o600);
    const fixture = path.join(root, 'native.mjs');
    await writeFile(
      fixture,
      `import {spawn} from 'node:child_process';import {once} from 'node:events';
const c=spawn(process.execPath,[${JSON.stringify(path.resolve('dist/management/callback.js'))},'antigravity'],{env:process.env,stdio:['pipe','pipe','ignore']});
let output='';c.stdout.on('data',d=>output+=d);
c.stdin.end(JSON.stringify({email:'isolated@example.test',quota:{weekly:{remaining_fraction:0.5}}}));
await once(c,'exit');if(!output.includes('observation recorded'))process.exit(2);
`,
    );
    const runtime = await mkdtemp(path.join(tmpdir(), 'principal-agy-'));
    const home = path.join(root, 'home');
    try {
      const code = await runNative(
        {
          executable: process.execPath,
          args: [
            path.resolve('dist/management/antigravity-isolation.js'),
            process.execPath,
            fixture,
          ],
          env: {
            ...process.env,
            HOME: home,
            XDG_CONFIG_HOME: path.join(home, '.config'),
            XDG_DATA_HOME: path.join(home, '.local/share'),
            XDG_STATE_HOME: path.join(home, '.local/state'),
            XDG_RUNTIME_DIR: runtime,
            PRINCIPAL_MANAGEMENT_SOCKET: socket,
            PRINCIPAL_INVOCATION_ID: '11111111-1111-4111-8111-111111111111',
          },
          keyringPassword: Buffer.from(randomBytes(32).toString('base64')),
          trackNativePid: true,
        },
        root,
      );
      assert.equal(code, 0);
      assert.equal(received.method, 'observe');
      assert.equal(received.params.resources[0].value, 50);
      assert.equal(received.params.invocationId, '11111111-1111-4111-8111-111111111111');
    } finally {
      await new Promise((r) => server.close(r));
      await rm(root, { recursive: true, force: true });
    }
  },
);
