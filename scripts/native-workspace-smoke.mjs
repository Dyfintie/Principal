import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { rpc } from '../dist/client.js';
import { ConfigSchema } from '../dist/schema.js';
const directory = await mkdtemp(path.join(tmpdir(), 'principal-native-workspace-'));
const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
git('init','-q');
await writeFile(path.join(directory,'user.txt'),'existing user changes\n');
git('add','user.txt');
const indexBefore = await readFile(path.join(directory,'.git/index'));
const native = await rpc('native.open',{repo:directory,pool:'session-smoke',account:process.argv[2] ?? 'antigravity-1',config:ConfigSchema.parse({})});
try {
  const mounts = JSON.parse(execFileSync('docker',['inspect',native.container,'--format','{{json .Mounts}}'],{encoding:'utf8'}));
  assert.ok(mounts.some(mount => mount.Destination === native.workingDirectory && mount.RW));
  assert.ok(!mounts.some(mount => mount.Destination === path.join(native.workingDirectory,'.git')));
  execFileSync('docker',['exec',native.container,'node','-e', 'require("node:fs").writeFileSync(process.argv[1],"native workspace update\\n")',path.join(native.workingDirectory,'native.txt')]);
  assert.equal(await readFile(path.join(directory,'native.txt'),'utf8'),'native workspace update\n');
  assert.deepEqual(await readFile(path.join(directory,'.git/index')),indexBefore);
  execFileSync('docker',['exec',native.container,'git','-C',native.workingDirectory,'add','native.txt']);
  assert.ok(git('ls-files').includes('native.txt'));
  assert.equal(await readFile(path.join(directory,'user.txt'),'utf8'),'existing user changes\n');
  const evidence={at:new Date().toISOString(),directory,provider:native.provider,nativeWritableMount:true,hostFilesVisible:true,nativeGitWritesAllowed:true,userFilePreserved:true};
  await writeFile(path.join(directory,'evidence.json'),JSON.stringify(evidence,null,2));
  console.log(`PASS native direct workspace, Git access and existing user file preservation. Evidence ${directory}/evidence.json`);
} finally { await rpc('native.close',{owner:native.owner}); }
