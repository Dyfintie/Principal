#!/usr/bin/env python3
"""Exercise the actual provider TUI and return to Principal (requires pyte)."""
import os, pty, fcntl, termios, struct, subprocess, select, time, tempfile, sys, re, codecs
import pyte
from pathlib import Path
root=Path(__file__).resolve().parent.parent
account=sys.argv[1]
repo=tempfile.mkdtemp(prefix='principal-native-mode-')
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',32,100,0,0))
proc=subprocess.Popen(['node',str(root/'bin/principal.mjs')],stdin=slave,stdout=slave,stderr=slave,cwd=repo,env=dict(os.environ,TERM='xterm-256color'))
os.close(slave)
screen=pyte.Screen(100,32);stream=pyte.Stream(screen);decoder=codecs.getincrementaldecoder('utf8')('replace')
output=b''
def collect(seconds):
    global output
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if select.select([master],[],[],.1)[0]:
            try:chunk=os.read(master,65536)
            except OSError:break
            output+=chunk;stream.feed(decoder.decode(chunk))
            if b'\x1b[?u' in chunk:os.write(master,b'\x1b[?0u')
            if b'\x1b[6n' in chunk:
                os.write(master,f'\x1b[{screen.cursor.y+1};{screen.cursor.x+1}R'.encode())
def send(data):
    os.write(master,data);collect(.5)
def display():return '\n'.join(screen.display)
def wait_for(predicate,seconds):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        collect(.5)
        if predicate(display()):return
        if proc.poll() is not None:break
    text=re.sub(r'[\w.+-]+@[\w.-]+','[account]',display())
    raise AssertionError(text)
try:
    wait_for(lambda text:'Principal' in text,15)
    send(b'/pool session-smoke');send(b'\r')
    send(('/lead '+account).encode());send(b'\r')
    send(b'/mode native');send(b'\r')
    wait_for(lambda text:'Choose your color scheme' in text or 'Codex' in text or 'Antigravity' in text,60)
    collect(3)
    if 'Choose your color scheme' in display():send(b'\r');collect(2)
    if 'trust' in display().lower():send(b'\r');collect(2)
    print('Native UI opened:',account,flush=True)
    print(re.sub(r'[\w.+-]+@[\w.-]+','[account]',display()),flush=True)
    if '--reply' in sys.argv and 'Terms of Service' in display():
        raise AssertionError('Provider onboarding requires user choices; do not accept terms or data sharing in a smoke test')
    if '--reply' in sys.argv:
        send(b'What is 17 plus 26? Reply with only the number.');send(b'\r')
        wait_for(lambda text:any(line.strip().lstrip('>\u25cf\u2022 ').strip()=='43' for line in text.splitlines()),180)
        print('PASS: live native response = 43',flush=True)
    send(b'\x03');collect(1);send(b'\x03')
    wait_for(lambda text:'Principal ·' in text,90)
    assert b'Account:' in output
    print('PASS: native provider interface exited and returned to Principal',flush=True)
    send(b'/mode principal');send(b'\r')
    assert b'Mode: principal' in output
    send(b'/mode native');send(b'\r')
    wait_for(lambda text:('Terms of Service' in text or 'Welcome to Antigravity' in text or ('OpenAI Codex' in text and '? for shortcuts' in text)) and 'Principal mode' not in text,60)
    send(b'\x03');collect(1);send(b'\x03')
    wait_for(lambda text:'Principal ·' in text,90)
    print('PASS: /mode native switches out of chat and restores the Principal session',flush=True)
    send(b'/exit');send(b'\r')
    assert proc.wait(timeout=15)==0
    print('PASS: mode selection, provider terminal, return, explicit Principal mode and clean detach',flush=True)
finally:
    if proc.poll() is None:proc.terminate();proc.wait(timeout=90)
    os.close(master)
