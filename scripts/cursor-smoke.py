#!/usr/bin/env python3
"""Verify Ink positions and shows the real terminal cursor inside the draft."""
import os,pty,select,subprocess,time,fcntl,termios,struct,re,sys,signal
from pathlib import Path
root=Path(__file__).resolve().parent.parent
screen=None
if '--screen' in sys.argv:
    import pyte
    screen=pyte.Screen(55,12);stream=pyte.Stream(screen)
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',12,55,0,0))
proc=subprocess.Popen(['node',str(root/'bin/principal.mjs')],stdin=slave,stdout=slave,stderr=slave,cwd=root)
os.close(slave);output=b''
def collect(seconds):
    global output
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if select.select([master],[],[],.1)[0]:
            try:
                chunk=os.read(master,65536);output+=chunk
                if screen:stream.feed(chunk.decode('utf8',errors='replace'))
            except OSError:break

def send(data):
    os.write(master,data);collect(.4)
def column():
    positions=re.findall(rb'\x1b\[(\d+)G\x1b\[\?25h',output)
    assert positions,output[-2000:]
    if screen:
        assert not screen.cursor.hidden
        line=screen.display[screen.cursor.y]
        assert line.startswith('│ ') and '❯' in '\n'.join(screen.display[max(0,screen.cursor.y-1):screen.cursor.y+1]), (screen.cursor.x,screen.cursor.y,screen.display)
        assert screen.cursor.x==int(positions[-1])-1
    return int(positions[-1])
try:
    collect(1)
    send(('/resume ' + sys.argv[1]).encode()); send(b'\r'); collect(2)
    send(b"\x15")
    assert column()==5
    send(b'hello');assert column()==10
    send(b'\x15');send('你好'.encode());assert column()==9
    for _ in range(10):
        collect(.3);assert column()==9
    send(b'\x15');send(b'x'*100+b'end');assert column()==53
    assert b'end' in output
    send(b'\x15');send(b'\x1b[200~first\nsecond\x1b[201~');assert column()==11
    send(b'\x15');send(b'/');assert column()==6
    send(b'\x15')
    if screen:
        screen.resize(24,100)
        fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',24,100,0,0))
        proc.send_signal(signal.SIGWINCH);collect(.5)
        send(b'hello');assert column()==10
        assert screen.cursor.y==20, (screen.cursor.y,screen.display)
    send(b'\x15');send(b'/exit');send(b'\r')
    assert proc.wait(timeout=5)==0
    assert b'\x1b[?25h' in output
    print('PASS: visible terminal cursor aligns with empty, typed, Unicode, long and multiline drafts; detach restores terminal')
finally:
    if proc.poll() is None:proc.terminate();proc.wait(timeout=5)
    os.close(master)
