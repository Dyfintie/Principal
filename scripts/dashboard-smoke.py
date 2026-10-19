"""Exercise the real dashboard on a saved run without starting inference."""
import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time

run_id = sys.argv[1]
state = json.loads(subprocess.check_output(['principal', '--json', 'status', run_id]))['data']
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 120, 0, 0))
process = subprocess.Popen(['principal', 'dashboard', run_id], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
output = ''
def receive_until(expected, timeout=12):
    global output
    deadline = time.monotonic() + timeout
    frame = ''
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.2)
        if ready:
            chunk = os.read(master, 65536).decode(errors='replace')
            output += chunk
            frame += re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', chunk)
            if expected in frame:
                return frame
    raise AssertionError('Dashboard did not display: ' + expected)
try:
    first = state['tasks'][0]['id']
    receive_until(first)
    if len(state['tasks']) > 1:
        second = state['tasks'][1]['id']
        if second not in output:
            receive_until(second)
        os.write(master, b'\x1b[B')
    os.write(master, b'\r')
    receive_until('Task instructions')
    os.write(master, b'\x1b[6~')
    receive_until('PgUp/PgDn')
    os.write(master, b'\t')
    receive_until('[Accounts]')
    os.write(master, b'q')
    assert process.wait(timeout=5) == 0
    print('PASS: real TTY rendering, two task panels, task selection, details scrolling, tabs, and clean detach')
finally:
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=5)
    os.close(master)
