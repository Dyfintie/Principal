import type { ProcessIdentity } from './model.js';
import { exec } from '../util.js';

/** Open pidfds, validate identity/uid, discover the owned tree, then signal handles. */
export async function signalWorkerProcesses(roots: ProcessIdentity[], signal: 'SIGTERM' | 'SIGKILL'): Promise<ProcessIdentity[]> {
  if (!roots.length) return [];
  const script = `import os, sys, json, signal
roots, requested = json.loads(sys.argv[1])
with open('/proc/sys/kernel/random/boot_id') as f: boot = f.read().strip()
def identify(pid):
    try:
        if os.stat('/proc/'+str(pid)).st_uid != os.getuid(): return None
        with open('/proc/'+str(pid)+'/stat') as f: fields = f.read().rsplit(') ',1)[1].split()
        if fields[0] in ('Z','X'): return None
        return ({'pid':pid,'startTime':fields[19],'bootId':boot}, int(fields[2]), int(fields[3]))
    except (OSError,ValueError): return None
found = {}
groups = set()
for root in roots:
    actual = identify(root['pid'])
    if actual and actual[0] == root:
        found[root['pid']] = root
        if actual[1] == root['pid'] and actual[2] == root['pid']: groups.add(root['pid'])
# Each provider is started in a new session. Include its remaining group members.
for name in os.listdir('/proc'):
    if not name.isdigit(): continue
    actual = identify(int(name))
    if actual and actual[1] in groups and actual[2] in groups: found[int(name)] = actual[0]
queue = list(found)
for pid in queue:
    try:
        with open('/proc/'+str(pid)+'/task/'+str(pid)+'/children') as f: children = f.read().split()
    except OSError: continue
    for child in children:
        actual = identify(int(child))
        if actual and int(child) not in found:
            found[int(child)] = actual[0]
            queue.append(int(child))
handles = []
try:
    for identity in found.values():
        try:
            fd = os.pidfd_open(identity['pid'])
            actual = identify(identity['pid'])
            if actual and actual[0] == identity: handles.append(fd)
            else: os.close(fd)
        except ProcessLookupError: pass
    for fd in reversed(handles):
        try: signal.pidfd_send_signal(fd,getattr(signal,requested))
        except ProcessLookupError: pass
finally:
    for fd in handles: os.close(fd)
print(json.dumps(list(found.values())))
`;
  const result = await exec('python3', ['-c', script, JSON.stringify([roots, signal])], { timeout: 5000, maxBytes: 1024 * 1024 });
  return JSON.parse(result.stdout.toString());
}
