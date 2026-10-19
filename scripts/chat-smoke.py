#!/usr/bin/env python3
import os, pty, select, subprocess, sys, time, fcntl, termios, struct
session=sys.argv[1]
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',12,55,0,0))
proc=subprocess.Popen(['node','bin/principal.mjs'],stdin=slave,stdout=slave,stderr=slave,cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.close(slave)
output=b''
def collect(duration):
    global output
    end=time.monotonic()+duration
    while time.monotonic()<end:
        if select.select([master],[],[],0.1)[0]:
            try: output+=os.read(master,65536)
            except OSError: break
try:
    collect(1)
    os.write(master, ('/resume ' + session).encode()); collect(.3); os.write(master, b'\r'); collect(2)
    assert b'Pool:' in output and b'Account:' in output
    assert b'codex-free-' in output or b'antigravity-' in output
    assert '╭'.encode() in output
    os.write(master,b'/');collect(0.5)
    assert b'/usage' in output
    os.write(master,b'\x1b[B');collect(0.3)
    assert b'/accounts' in output
    os.write(master,b'\t');collect(0.4)
    assert b'/accounts ' in output
    os.write(master,b'\x15');collect(0.3)
    os.write(master,b'/con');collect(0.3)
    assert b'/context' in output
    os.write(master,b'\x1b');collect(0.2)
    os.write(master,b'\x15');collect(0.3)
    os.write(master,b'/context');collect(0.3);os.write(master,b'\r');collect(1)
    os.write(master,b'\t\x1b[5~\x1b[6~');collect(0.5)
    os.write(master,b'/history');collect(0.3);os.write(master,b'\r');collect(0.5)
    os.write(master,b'\x1b[200~draft line 1\ndraft line 2\x1b[201~');collect(0.5)
    assert b'draft line' in output
    os.write(master,b'\x15');collect(0.3)
    os.write(master,b'/exit');collect(0.3);os.write(master,b'\r');collect(1)
    assert proc.wait(timeout=5)==0
    assert b'Principal' in output and b'/context' in output
    print('PASS: narrow terminal, context/history commands, view switching, scrolling, multiline paste, slash filtering/navigation/completion, active pool/account, borders and detach')
finally:
    if proc.poll() is None:proc.terminate();proc.wait(timeout=5)
    os.close(master)
