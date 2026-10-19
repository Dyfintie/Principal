import { realpath, writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';

if (Number(process.versions.node.split('.')[0]) < 24) {
  throw new Error('Principal requires Node 24+ for installation and builds.');
}
// Loading SQLite here prevents recording a runtime incompatible with the native dependency.
const db = new Database(':memory:');
db.close();
await writeFile(new URL('../dist/host-runtime.json', import.meta.url), JSON.stringify({
  executable: await realpath(process.execPath),
  version: process.version,
  abi: process.versions.modules,
}, null, 2) + '\n');
