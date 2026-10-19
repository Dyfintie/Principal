"""Exercise native management in a PTY using a caller-owned synthetic state.

Run only with the temporary fixture environment created by the integration test.
No login or real provider calls are made.
"""
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

node, launcher, project = sys.argv[1:4]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
process = subprocess.Popen([node, launcher], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
captured = ''


def receive(expected, timeout=12, idle=False):
    global captured
    frame = ''
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.1)
        if not ready:
            continue
        try:
            chunk = os.read(master, 65536).decode(errors='replace')
        except OSError:
            break
        captured += chunk
        frame += re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', chunk)
        idle_view = '/diagnostics' if '/diagnostics' in expected else '/profiles'
        if expected in frame and (not idle or re.search(r'Principal [^\r\n]*· ' + re.escape(idle_view) + r'\r?\n', frame)):
            return frame
    raise AssertionError('Missing PTY frame: ' + expected + '\n' + captured[-4000:])


def native_return(message='Native tool exited (0); management resumed.'):
    # Wait for a fresh child invocation, not a notice left by a previous handoff.
    frame = receive('synthetic native invocation').split('synthetic native invocation')[-1]
    if message not in frame:
        frame += receive(message)
    return frame


def send(data):
    # A PTY reports full frames before React's input effects finish committing.
    # Separate key events as a real interactive terminal would.
    time.sleep(0.15)
    os.write(master, data)


try:
    initial_frame = receive('· /usage')
    if 'type / for management commands' not in initial_frame:
        receive('type / for management commands')
    assert '[Sessions]' not in initial_frame, 'The section tab bar must be removed'
    send(b'/sessions')
    send(b'\r')
    frame = receive('· /sessions')
    send(b'\t')
    send(b'2')
    send(b'?')
    frame = receive('Sessions: n launch')
    assert '· /sessions' in frame, 'Tab and digit keys must not change sections'
    send(b'/')
    receive('Existing accounts and authentication status')
    send(b'\x1b[B')
    send(b'\t')
    receive('/accounts')
    send(b'\r')
    receive('ACCOUNTS · existing native profiles')
    send(b'\x1b')
    send(b'/sessions')
    send(b'\r')
    receive('· /sessions')
    receive('Unassigned') if 'Unassigned' not in captured else None
    send(b'f')
    time.sleep(0.1)
    send(b'Fixture history')
    time.sleep(0.1)
    send(b'\r')
    receive('Fixture history')
    send(b'\x1b')
    time.sleep(0.15)
    send(b'/profiles')
    send(b'\r')
    receive('· /profiles', idle=True)
    # Rename through the real TUI, then restore the fixture name for later launch.
    send(b'r')
    receive('Rename profile')
    send(b'-renamed')
    time.sleep(0.15)
    send(b'\r')
    receive('Profile renamed.')
    send(b'r')
    receive('Rename profile')
    send(b'\x15')
    send(b'fixture')
    send(b'\r')
    receive('Profile renamed.')
    # Menus expose profile operations without typing CLI commands.
    send(b'\r')
    receive('Profile actions')
    receive('Jump to current run') if 'Jump to current run' not in captured else None
    receive('Check authentication') if 'Check authentication' not in captured else None
    send(b'\x1b[B')
    time.sleep(0.15)
    send(b'\r')
    receive('synthetic@example.test')
    send(b'P')
    receive('No current run is recorded for fixture.')
    # Basic setup asks for only a name; advanced fields are an explicit opt-in.
    send(b'n')
    frame = receive('Add account and sign in')
    if 'Profile name' not in frame:
        frame += receive('Profile name')
    assert 'Configuration:' not in frame and 'Existing directory' not in frame
    send(b'\r')
    receive('Enter a profile name, such as Personal or Other.')
    send(b'\x1b')
    # Provider tabs filter accounts and wrap in both directions.
    for name in ['Antigravity', 'Copilot', 'Claude', 'Codex']:
        send(b'\t')
        receive('PROFILES · ' + name)
    send(b'\x1b[Z')
    receive('PROFILES · Claude')
    send(b'\t')
    receive('PROFILES · Codex')
    send(b'N')
    receive('Add native profile (advanced)')
    # Antigravity must be selectable in the same management form.
    for _ in range(3):
        send(b'\x1b[C')
        time.sleep(0.1)
    receive('antigravity')
    for _ in range(3):
        send(b'\x1b[D')
        time.sleep(0.1)
    # Empty names stay in the form and focus the name field with a readable error.
    send(b'\r')
    receive('Enter a profile name, such as Personal or Other.')
    # Register only a caller-owned synthetic directory, never real home credentials.
    time.sleep(0.15)
    send(b'tui-profile')
    time.sleep(0.15)
    send(b'\t')
    time.sleep(0.15)
    send(b'\t')
    time.sleep(0.15)
    send(project.encode())
    time.sleep(0.15)
    send(b'\r')
    receive('Profile registered.')
    # Open the launch form, check profile selector, then cancel without inference.
    send(b's')
    receive('Launch native agent')
    send(b'\x1b[C')
    time.sleep(0.15)
    send(b'\x1b')
    time.sleep(0.15)
    send(b'I')
    receive('This profile already uses native history.')
    send(b'\x1b[B')
    send(b'I')
    frame = receive('Load existing Codex history')
    if 'Enter confirms' not in frame:
        frame += receive('Enter confirms')
    assert 'profile login is preserved' in frame
    send(b'\t')
    send(b'\x1b')
    send(b'\x1b[A')
    send(b'h')
    receive('choose Import next history page')
    send(b'\r')
    receive('Import next history page')
    send(b'\x1b')
    send(b'H')
    receive('history page complete')
    send(b'/usage')
    send(b'\r')
    frame = receive('· /usage')
    if 'Usage updated.' not in frame:
        receive('Usage updated.')
    send(b'\r')
    receive('Resource actions')
    send(b'\r')
    receive('Usage updated.')
    send(b'/diagnostics')
    send(b'\r')
    receive('· /diagnostics')
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 20, 60, 0, 0))
    process.send_signal(signal.SIGWINCH)
    send(b'/sessions')
    send(b'\r')
    receive('· /sessions')
    # Search reveals folder/project ancestry without changing persisted expansion.
    send(b'\x1b')
    send(b'f')
    time.sleep(0.1)
    send(b'Fixture history')
    time.sleep(0.1)
    send(b'\r')
    receive('Fixture history')
    # Navigate to the entry, then resume the synthetic native CLI and return.
    send(b'\x1b[C')
    time.sleep(0.15)
    send(b'\x1b[C')
    time.sleep(0.15)
    send(b'\r')
    receive('Session actions')
    send(b'\x1b[B')
    send(b'\x1b[B')
    send(b'\r')
    receive('Session details')
    send(b'\x1b')
    send(b'C')
    frame = receive('Copy complete saved conversation')
    if 'Destination profile' not in frame:
        frame += receive('Destination profile')
    assert 'tui-profile' in frame
    send(b'\x1b')
    send(b'R')
    native_return()
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 100, 0, 0))
    process.send_signal(signal.SIGWINCH)
    # Management only: provider usage tabs never route to task execution.
    send(b'/usage --refresh')
    send(b'\r')
    frame = receive('ACCOUNT USAGE · Codex')
    if 'Usage updated.' not in frame:
        frame += receive('Usage updated.')
    assert 'enrolled-fixture' not in frame, 'Codex tab must exclude Antigravity accounts'
    send(b'\t')
    frame = receive('ACCOUNT USAGE · Antigravity')
    assert 'enrolled-fixture' in frame, 'Antigravity tab must include its enrolled accounts'
    send(b'\t')
    receive('ACCOUNT USAGE · Copilot')
    send(b'\t')
    receive('ACCOUNT USAGE · Claude')
    send(b'\t')
    receive('ACCOUNT USAGE · Codex')
    send(b'\x1b[Z')
    receive('ACCOUNT USAGE · Claude')
    # Delayed read-only fixture usage must not lock slash view navigation.
    delay_file = os.path.join(project, 'delay-usage')
    with open(delay_file, 'w') as marker:
        marker.write('synthetic delay')
    send(b'/usage --refresh')
    send(b'\r')
    receive('Working…')
    send(b'/profiles')
    send(b'\r')
    frame = receive('View switched; current observations are still loading.')
    assert '· /profiles' in frame, 'Slash navigation must work during observation loading'
    receive('Usage updated.')
    os.unlink(delay_file)
    send(b'/accounts')
    send(b'\r')
    frame = receive('ACCOUNTS · existing native profiles')
    if 'enrolled@example.test' not in frame:
        send(b'\x1b[B')
        send(b'\x1b[B')
        send(b'\x1b[B')
        receive('enrolled@example.test')
    send(b'/profiles')
    send(b'\r')
    receive('· /profiles', idle=True)
    send(b'\t')
    frame = receive('PROFILES · Antigravity')
    if 'enrolled-fixture · antigravity' not in frame:
        frame += receive('enrolled-fixture · antigravity')
    assert 'fixture · codex' not in frame.rsplit('Principal ·', 1)[-1]
    send(b'\r')
    frame = receive('Profile actions')
    if 'View account/session details' not in frame:
        frame += receive('View account/session details')
    assert 'Sign in using native tool' not in frame, 'Cached rows must not offer native login'
    send(b'\x1b[B')
    send(b'\r')
    receive('Saved metadata from Principal')
    send(b'\x1b')
    send(b'/back')
    send(b'\r')
    receive('· /sessions')
    send(b'/run')
    send(b'\r')
    receive('Task execution is not available.')
    send(b'/folders create "TUI Folder/Nested"')
    send(b'\r')
    receive('Management result')
    send(b'\x1b')
    # Delete only the synthetic profile registered above; no native files are removed.
    send(b'/profiles')
    send(b'\r')
    receive('· /profiles', idle=True)
    send(b'\x1b[Z')
    receive('PROFILES · Codex')
    send(b'\x1b[B')
    time.sleep(0.1)
    send(b'd')
    receive('Type remove to unregister tui-profile')
    send(b'\r')
    receive('Type remove to confirm')
    send(b'remove')
    time.sleep(0.15)
    send(b'\r')
    receive('Profile removed from Principal.')
    assert os.path.isdir(project), 'Removing a profile must retain its native directory'
    # Choose a project in the selected profile's native launch form.
    send(b's')
    receive('Launch native agent')
    send(b'\t')
    send(b'\x15')
    send(project.encode())
    send(b'\r')
    native_return()
    with open(os.path.join(os.path.dirname(project), 'launch.json')) as record:
        launched = json.load(record)
    assert launched['profile'] == os.path.join(os.path.dirname(project), 'native-config')
    assert launched['cwd'] == project
    assert launched['args'] == ['--no-daemon']
    send(b'/launch --profile fixture --cwd "' + project.encode() + b'" -- --model "quoted model"')
    send(b'\r')
    frame = native_return()
    if 'fixture · codex' not in frame:
        receive('fixture · codex')
    # Adding a new account uses an isolated configuration and enters native login.
    send(b'a')
    receive('Existing native login is already registered.')
    send(b'n')
    receive('Add account and sign in')
    send(b'simple-login')
    send(b'\r')
    frame = native_return('Native sign-in exited (0); returned to Profiles.')
    if '› simple-login · codex' not in frame:
        receive('› simple-login · codex')
    with open(os.path.join(os.path.dirname(project), 'launch.json')) as record:
        signed_in = json.load(record)
    assert signed_in['args'] == ['login']
    assert signed_in['profile'] != os.path.join(os.path.dirname(project), 'native-config')
    assert os.path.isdir(signed_in['profile'])
    send(b'D')
    frame = native_return('Native sign-in exited (0); returned to Profiles.')
    if '› simple-login · codex' not in frame:
        receive('› simple-login · codex')
    with open(os.path.join(os.path.dirname(project), 'launch.json')) as record:
        device_login = json.load(record)
    assert device_login['args'] == ['login', '--device-auth']
    assert device_login['profile'] == signed_in['profile']
    send(b's')
    receive('Launch native agent')
    send(b'\t')
    send(b'\x15')
    send(project.encode())
    send(b'\r')
    frame = native_return()
    if '› simple-login · codex' not in frame:
        receive('› simple-login · codex')
    with open(os.path.join(os.path.dirname(project), 'launch.json')) as record:
        relaunched = json.load(record)
    assert relaunched['args'] == ['--no-daemon']
    assert relaunched['profile'] == signed_in['profile']
    assert relaunched['cwd'] == project
    # Add a synthetic Antigravity installation only after the cached-account tests.
    # Connecting an existing login and canceling sign-in must never launch it.
    fixture_root = os.path.dirname(project)
    agy_record = os.path.join(fixture_root, 'agy-launch.json')
    agy = os.path.join(fixture_root, 'bin', 'agy')
    os.makedirs(os.path.join(fixture_root, '.gemini', 'antigravity-cli'), exist_ok=True)
    with open(agy, 'w') as executable:
        executable.write('#!' + node + '\n'
                         "if (process.argv.includes('--version')) { console.log('1.3.99'); process.exit(0); }\n"
                         "if (process.argv.includes('--help')) { console.log('Usage of agy:\\n  --conversation  Resume a previous conversation by ID'); process.exit(0); }\n"
                         "const fs = await import('node:fs/promises');\n"
                         'await fs.writeFile(' + json.dumps(agy_record) + ', JSON.stringify(process.argv.slice(2)));\n'
                         "console.log('synthetic native invocation');\n"
                         "await new Promise(resolve => setTimeout(resolve, 500));\n"
                         "const {spawn} = await import('node:child_process');\n"
                         'const child = spawn(process.execPath, [' + json.dumps(os.path.join(os.path.dirname(os.path.dirname(launcher)), 'dist', 'management', 'callback.js')) + ", 'antigravity'], {env:process.env,stdio:['pipe','pipe','pipe']});\n"
                         "let output='';child.stdout.on('data', b => output+=b);\n"
                         'child.stdin.end(JSON.stringify({email:"antigravity-fixture@example.test",cwd:' + json.dumps(project) + ',agent_state:"idle",quota:{weekly:{remaining_fraction:0.75}}}));\n'
                         "const [code] = await (await import('node:events')).once(child,'exit');\n"
                         'await fs.writeFile(' + json.dumps(os.path.join(fixture_root, 'agy-observation.json')) + ', JSON.stringify({code,output,invocation:process.env.PRINCIPAL_INVOCATION_ID}));\n')
    os.chmod(agy, 0o700)
    send(b'/diagnostics')
    send(b'\r')
    receive('· /diagnostics', idle=True)
    send(b'v')
    receive('Installed tools rechecked.')
    send(b'/profiles')
    send(b'\r')
    receive('· /profiles', idle=True)
    send(b'\t')
    receive('PROFILES · Antigravity')
    send(b'n')
    frame = receive('Add account and sign in · Antigravity')
    assert 'Experimental' in frame and 'Profile name' in frame
    send(b'\x1b')
    assert not os.path.exists(agy_record), 'Canceling add account must not start Antigravity'
    send(b'a')
    receive('Existing native login is already registered.')
    assert not os.path.exists(agy_record), 'Use existing login must not start Antigravity'
    send(b'l')
    receive('Antigravity · connect your native login')
    send(b'\x1b')
    assert not os.path.exists(agy_record), 'Canceling sign-in must not start Antigravity'
    # The explicit management slash command uses the same explanation.
    send(b'/profiles login native-antigravity')
    send(b'\r')
    receive('Antigravity · connect your native login')
    send(b'\x1b')
    assert not os.path.exists(agy_record), 'Canceling slash sign-in must not start Antigravity'
    send(b'l')
    receive('Antigravity · connect your native login')
    send(b'\r')
    native_return('Native sign-in exited (0); returned to Profiles.')
    with open(agy_record) as record:
        assert json.load(record) == [], 'Sign-in must not invent OAuth flags or send an agent prompt'
    with open(os.path.join(fixture_root, 'agy-observation.json')) as record:
        observation = json.load(record)
        assert observation['invocation'], 'Native sign-in must bind its process to the selected profile'
        assert observation['code'] == 0 and 'observation recorded' in observation['output']
    send(b'/exit')
    send(b'\r')
    assert process.wait(timeout=5) == 0
    print('PASS: native management PTY tree/search, provider profile tabs, simple native sign-in, advanced profile menus/add/rename/remove/inspect/launch/history, resources refresh, slash-only views, resize, resume handoff, provider usage cycling in both directions and wraparound, task execution rejection and management-only return')
finally:
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=5)
    os.close(master)
