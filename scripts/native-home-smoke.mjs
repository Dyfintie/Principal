import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { rpc } from '../dist/client.js';
import { paths } from '../dist/util.js';
const directory = await realpath(homedir());
const protectedRoots = await Promise.all([paths.state, paths.config].map(root => realpath(root)));

const native = await rpc('native.open',{repo:directory,pool:'session-smoke',account:'antigravity-1'});
const targets = protectedRoots.map(root => path.posix.join(native.workingDirectory, path.relative(directory,root)));
try {
  const code = 'const fs=require("node:fs"); const targets=JSON.parse(process.argv[1]); for(const target of targets){ try { if(fs.readdirSync(target).length) throw Error("Managed credential storage is visible"); } catch(error){if(!["EACCES","ENOENT"].includes(error.code))throw error;} } console.log("protected")';
  const result = execFileSync('docker',['exec',native.container,'node','-e',code,JSON.stringify(targets)],{encoding:'utf8'});
  assert.equal(result.trim(),'protected');
  const mounts = JSON.parse(execFileSync('docker',['inspect',native.container,'--format','{{json .HostConfig.Tmpfs}}'],{encoding:'utf8'}));
  for(const target of targets) assert.ok(mounts[target]?.includes('ro'));
  console.log('PASS: native home-directory workspace hides Principal state and configuration; no host files modified');
} finally {await rpc('native.close',{owner:native.owner});}
