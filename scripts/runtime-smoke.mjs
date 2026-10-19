import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const dir = await mkdtemp(path.join(tmpdir(), 'principal-runtime-smoke-'));
try {
  await writeFile(path.join(dir, 'marker.txt'), 'principal-smoke-marker\n');
  const code = `import os, errno
assert open('/workspace/marker.txt').read().strip() == 'principal-smoke-marker'
for p in ['/workspace/forbidden.txt', '/usr/local/bin/forbidden.txt']:
 try:
  open(p, 'w').write('forbidden')
  raise AssertionError('Unexpected writable path: ' + p)
 except OSError as e:
  assert e.errno == errno.EROFS, (p, e)
assert os.access('/usr/local/bin/codex-code-mode-host', os.X_OK)
assert os.access('/usr/bin/bwrap', os.X_OK)
status = open('/proc/self/status').read()
assert 'Seccomp:\\t2' in status
assert 'CapEff:\\t0000000000000000' in status
open('/tmp/allowed.txt', 'w').write('temporary')
print('PASS: helper installed; read-only workspace and root; writable tmpfs; default seccomp; zero effective capabilities')`;
  console.log(
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--user',
        `${process.getuid()}:${process.getgid()}`,
        '--tmpfs',
        '/tmp:mode=1777',
        '--mount',
        `type=bind,src=${dir},dst=/workspace,readonly`,
        '--entrypoint',
        'python3',
        process.env.PRINCIPAL_TEST_IMAGE ?? 'principal-runtime:local',
        '-c',
        code,
      ],
      { encoding: 'utf8' },
    ).trim(),
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
