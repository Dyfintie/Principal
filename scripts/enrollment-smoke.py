#!/usr/bin/env python3
"""Verify enrollment commands return to the same UI on a known duplicate label."""
import os,pty,select,subprocess,time,fcntl,termios,struct,json
from pathlib import Path
root=Path(__file__).resolve().parent.parent
accounts=json.loads(subprocess.check_output(['node','--input-type=module','-e', 'import { rpc } from ' + json.dumps((root/'dist/client.js').as_uri()) + '; console.log(JSON.stringify(await rpc("accounts.list")));'],text=True))
for label in ['codex-free-1','antigravity-1']:
    assert any(a['label']==label and a['status']=='ready' for a in accounts), 'Smoke test requires ready existing accounts'
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,100,0,0))
proc=subprocess.Popen(['node',str(root/'bin/principal.mjs')],stdin=slave,stdout=slave,stderr=slave,cwd=Path.home());os.close(slave)
output=b''
def collect(seconds):
    global output
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if select.select([master],[],[],.1)[0]:
            try:output+=os.read(master,65536)
            except OSError:break

def command(text):
    os.write(master,text.encode());collect(.3);os.write(master,b'\r');collect(1)
try:
    collect(2)
    command('/enroll codex codex-free-1')
    assert b'Account label codex-free-1 is already registered' in output
    command('/enroll antigravity antigravity-1')
    assert b'Account label antigravity-1 is already registered' in output
    command('/usage')
    assert b'ACCOUNT USAGE' in output
    command('/exit')
    assert proc.wait(timeout=5)==0
    print('PASS: both enrollment commands return to chat on duplicate labels; usage and clean detach remain available')
finally:
    if proc.poll() is None:proc.terminate();proc.wait(timeout=5)
    os.close(master)
