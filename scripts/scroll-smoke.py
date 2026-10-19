#!/usr/bin/env python3
"""Assert actual viewport changes for keyboard and terminal wheel input."""
import os,pty,select,subprocess,time,fcntl,termios,struct,re,sys
from pathlib import Path
root=Path(__file__).resolve().parent.parent
session=sys.argv[1]

def check(rows,columns):
    master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',rows,columns,0,0))
    proc=subprocess.Popen(['node',str(root/'bin/principal.mjs')],stdin=slave,stdout=slave,stderr=slave,cwd=root)
    os.close(slave);output=b''
    def collect(seconds):
        nonlocal output
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            if select.select([master],[],[],.1)[0]:
                try:output+=os.read(master,65536)
                except OSError:break
    def send(data):
        os.write(master,data);collect(.25)
    def position():
        matches=re.findall(rb'Rows (\d+)-(\d+)/(\d+)',output)
        assert matches,output[-2000:]
        return tuple(map(int,matches[-1]))
    def command(text):
        send(text.encode());send(b'\r');collect(.5)
    try:
        collect(1)
        command('/resume ' + session)
        collect(1)
        assert b'\x1b[?1006h' in output
        command('/usage');first=position()
        assert first[0]==1 and first[2]>first[1]
        send(b'\x1b[6~');assert position()[0]>first[0]
        send(b'\x1b[5~');assert position()[0]==first[0]
        send(b'\x1b[<65;20;8M');assert position()[0]==4
        send(b'\x1b[<64;20;8M'*30);assert position()[0]==1
        send(b'\x1b[<65;20;8M');assert position()[0]==4
        send(b'\x1b[M`!!');assert position()[0]==1
        command('/accounts');assert position()[0]==1
        send(b'\x1b[6~');assert position()[0]>1
        send(b'\x1b[5~');assert position()[0]==1
        send(b'keepdraft');collect(.2)
        before=output.count(b'keepdraft')
        send(b'\x1b[<65;20;8M');send(b'\x1b[<0;20;8M');send(b'\x1b[<0;20;8m')
        assert output.count(b'keepdraft')>=before
        assert b'keepdraft[<' not in output and b'keepdraft`!!' not in output
        send(b'\x15');command('/exit')
        assert proc.wait(timeout=5)==0
        assert b'\x1b[?1006l' in output and b'\x1b[?1000l' in output
    finally:
        if proc.poll() is None:proc.terminate();proc.wait(timeout=5)
        os.close(master)

check(12,55)
check(24,100)
print('PASS: PageUp/PageDown, wheel/touchpad SGR and legacy input, edge reversal, draft preservation and mode cleanup in narrow and standard terminals')
