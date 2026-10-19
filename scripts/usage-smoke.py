#!/usr/bin/env python3
"""Exercise account usage meters in the actual chat terminal without inference."""
import os, pty, select, subprocess, time, fcntl, termios, struct
from pathlib import Path
root=Path(__file__).resolve().parent.parent
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,100,0,0))
proc=subprocess.Popen(['node',str(root/'bin/principal.mjs')],stdin=slave,stdout=slave,stderr=slave,cwd=Path.home())
os.close(slave);output=b''
def collect(seconds):
    global output
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if select.select([master],[],[],.1)[0]:
            try:output+=os.read(master,65536)
            except OSError:break
try:
    collect(2)
    os.write(master,b'/usage');collect(.3);os.write(master,b'\r');collect(1)
    assert b'ACCOUNT USAGE' in output
    assert b'codex-free-1' in output and b'codex-free-2' in output and b'antigravity-1' in output
    assert b'GEMINI' in output and b'CLAUDE / GPT' in output
    assert '█'.encode() in output and b'Refreshes in' in output
    assert b'remainingPercent' not in output and b'"buckets"' not in output
    os.write(master,b'\x1b[6~');collect(.3)
    os.write(master,b'/exit');collect(.3);os.write(master,b'\r');collect(.7)
    assert proc.wait(timeout=5)==0
    print('PASS: all connected accounts, separate Antigravity weekly meters, reset countdowns, scrolling and no JSON')
finally:
    if proc.poll() is None:proc.terminate();proc.wait(timeout=5)
    os.close(master)
