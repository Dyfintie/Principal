import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Runtime } from '../dist/runtime.js';
import { ConfigSchema } from '../dist/schema.js';
import { exec, uid } from '../dist/util.js';
const runtime = new Runtime();
const account = {
  id: uid(),
  label: 'login-smoke',
  provider: 'antigravity',
  identity: null,
  plan: null,
  model: null,
  status: 'login',
  generation: 0,
  lastAssigned: 0,
};
const config = ConfigSchema.parse({});
const directory = await mkdtemp(path.join(tmpdir(), 'principal-login-smoke-'));
let container, peer, archive;
runtime.vault.load = async () => (archive ? Buffer.from(archive) : null);
const keyringScript =
  'export DBUS_SESSION_BUS_ADDRESS="$(cat /run/principal/dbus-address)"; secret-tool lookup service principal-smoke username fixture';
try {
  container = await runtime.create(account, config, { login: true });
  const key = path.join(directory, 'identity');
  await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  await exec(
    'docker',
    ['exec', '-i', container, 'sh', '-c', 'cat > /run/principal/authorized_keys'],
    { input: await readFile(key + '.pub') },
  );
  const port = (await exec('docker', ['port', container, '2222/tcp'])).stdout
    .toString()
    .trim()
    .split(':')
    .at(-1);
  const host = (
    await exec('docker', ['exec', container, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'])
  ).stdout
    .toString()
    .trim()
    .split(' ')
    .slice(0, 2)
    .join(' ');
  const known = path.join(directory, 'known_hosts');
  await writeFile(known, `[127.0.0.1]:${port} ${host}\n`, { mode: 0o600 });
  const ssh = await exec(
    'ssh',
    [
      '-tt',
      '-p',
      port,
      '-i',
      key,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${known}`,
      'principal@127.0.0.1',
      'printf principal-ssh-pty-ok',
    ],
    { timeout: 15000 },
  );
  if (!ssh.stdout.toString().includes('principal-ssh-pty-ok'))
    throw new Error('Interactive SSH did not execute');
  const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const environmentProbe =
    'import {loginEnvironment} from "/opt/principal/login-command.mjs"; import {createHash} from "node:crypto"; const env=await loginEnvironment(); console.log(JSON.stringify({rawProxy:!!process.env.HTTPS_PROXY,restoredHash:createHash("sha256").update(env.HTTPS_PROXY ?? "").digest("hex")}));';
  const sshArgs = [
    '-tt',
    '-p',
    port,
    '-i',
    key,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${known}`,
    'principal@127.0.0.1',
  ];
  const environmentResult = await exec(
    'ssh',
    [...sshArgs, 'node --input-type=module -e ' + shellQuote(environmentProbe)],
    { timeout: 15000 },
  );
  const { createHash } = await import('node:crypto');
  const proxy =
    config.runtime.proxy ??
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    '';
  const proxyEvidence = JSON.parse(environmentResult.stdout.toString().trim());
  if (proxy && !proxyEvidence.rawProxy)
    console.log('SSH proxy was unset; launcher restored the container proxy policy');
  if (proxyEvidence.restoredHash !== createHash('sha256').update(proxy).digest('hex'))
    throw new Error('SSH login did not restore container proxy policy');
  if (process.env.PRINCIPAL_CHECK_GOOGLE_HTTPS === '1') {
    const python =
      'import urllib.request, urllib.error\ntry:\n r=urllib.request.urlopen(urllib.request.Request("https://oauth2.googleapis.com/token",method="HEAD"),timeout=15)\n print("Google HTTPS reachable:",r.status)\nexcept urllib.error.HTTPError as e:\n assert e.code in [400,401,404,405], e.code\n print("Google HTTPS reachable:",e.code)';
    const source =
      'import {loginEnvironment} from "/opt/principal/login-command.mjs"; import {execFileSync} from "node:child_process"; process.stdout.write(execFileSync("python3",["-c",' +
      JSON.stringify(python) +
      '],{env:await loginEnvironment()}));';
    const connectivity = await exec(
      'ssh',
      [...sshArgs, 'node --input-type=module -e ' + shellQuote(source)],
      { timeout: 25000 },
    );
    console.log(connectivity.stdout.toString().trim());
  }
  const user = `${process.getuid()}:${process.getgid()}`;
  await exec('docker', [
    'exec',
    '--user',
    user,
    container,
    'sh',
    '-c',
    'export DBUS_SESSION_BUS_ADDRESS="$(cat /run/principal/dbus-address)"; printf "%s" principal-keyring-probe | secret-tool store --label="Principal smoke fixture" service principal-smoke username fixture',
  ]);
  const before = await exec('docker', [
    'exec',
    '--user',
    user,
    container,
    'sh',
    '-c',
    keyringScript,
  ]);
  if (before.stdout.toString().trim() !== 'principal-keyring-probe')
    throw new Error('Keyring fixture read-back mismatch');
  await exec('docker', [
    'exec',
    '--user',
    user,
    container,
    'sh',
    '-c',
    'mkdir -p /home/principal/.gemini/antigravity-cli/log /home/principal/.gemini/antigravity-cli/cache; printf fixture > /home/principal/.gemini/antigravity-cli/log/excluded.log; printf fixture > /home/principal/.gemini/antigravity-cli/cache/default_project_id.txt',
  ]);
  peer = await runtime.create({ ...account, id: uid() }, config);
  const address = (
    await exec('docker', [
      'inspect',
      container,
      '--format',
      '{{(index .NetworkSettings.Networks "principal-isolated").IPAddress}}',
    ])
  ).stdout
    .toString()
    .trim();
  const blocked = await exec('docker', [
    'exec',
    peer,
    'python3',
    '-c',
    'import socket,sys; s=socket.socket(); s.settimeout(2); code=s.connect_ex((sys.argv[1],2222)); assert code != 0, "peer SSH unexpectedly reachable"; print("PASS: peer SSH blocked")',
    address,
  ]);
  console.log(blocked.stdout.toString().trim());
  await runtime.stop(peer);
  peer = undefined;
  runtime.vault.save = async (_id, _provider, _generation, bytes) => {
    archive = Buffer.from(bytes);
  };
  await runtime.snapshot(account, container);
  const members = (await exec('tar', ['-tf', '-'], { input: archive })).stdout.toString();
  if (members.includes('excluded.log') || !members.includes('default_project_id.txt'))
    throw new Error('Snapshot telemetry exclusion or provider metadata retention failed');
  await runtime.stop(container);
  container = undefined;
  container = await runtime.create(account, config);
  const after = await exec('docker', [
    'exec',
    '--user',
    user,
    container,
    'sh',
    '-c',
    keyringScript,
  ]);
  if (after.stdout.toString().trim() !== 'principal-keyring-probe')
    throw new Error('Restored keyring fixture mismatch');
  console.log(
    'PASS: interactive SSH PTY, private keyring store/read, and cold keyring restoration; no provider credentials or inference used',
  );
} finally {
  if (peer) await runtime.stop(peer);
  if (container) await runtime.stop(container);
  archive?.fill(0);
  await rm(directory, { recursive: true, force: true });
}
