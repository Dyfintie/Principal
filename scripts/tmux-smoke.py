import os, pty, select, subprocess, sys, time

master, slave = pty.openpty()
code = "import {reopenEntry} from './dist/management/launcher.js';process.exitCode=await reopenEntry(process.argv[1]);"
child = subprocess.Popen([sys.argv[1], '--input-type=module', '-e', code, sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, 'TERM': 'xterm-256color'})
os.close(slave)
try:
    output = b''
    deadline = time.monotonic() + 15
    while b'synthetic native invocation' not in output and time.monotonic() < deadline:
        if select.select([master], [], [], .1)[0]:
            try: output += os.read(master, 65536)
            except OSError: break
    assert b'synthetic native invocation' in output, 'Persistent native terminal did not attach'
    os.write(master, b'\x02')
    time.sleep(.1)
    os.write(master, b'd')
    assert child.wait(timeout=5) == 0, 'Detaching failed'
finally:
    if child.poll() is None: child.terminate()
    os.close(master)
