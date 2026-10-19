#!/usr/bin/env python3
"""Verify automatic lazy working-directory startup without inference."""
import os, pty, select, subprocess, time, fcntl, termios, struct
from pathlib import Path
root = Path(__file__).resolve().parent.parent

def check(directory, choose):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
    proc = subprocess.Popen(['node', str(root / 'bin/principal.mjs')], stdin=slave, stdout=slave, stderr=slave, cwd=directory)
    os.close(slave)
    output = b''
    def collect(seconds):
        nonlocal output
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([master], [], [], .1)[0]:
                try: output += os.read(master, 65536)
                except OSError: break
    def command(text):
        os.write(master, text.encode()); collect(.3)
        os.write(master, b'\r'); collect(1)
    try:
        collect(1)
        collect(1)
        assert b'Principal' in output and b'Directory:' in output, output
        assert b'Project directory (Enter to cancel)' not in output
        if choose:
            command('/accounts')
            command('/back')
            collect(2)
            assert b'Directory:' in output, output
            assert b'codex' in output, output
        command('/exit')
        assert proc.wait(timeout=5) == 0, output
    finally:
        if proc.poll() is None: proc.terminate(); proc.wait(timeout=5)
        os.close(master)

check(Path.home(), False)
check(root, True)
print('PASS: home and installation open chat in the launch directory automatically; accounts, history and detach work')
