import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { restoreNativeSettings, saveNativeSettings } from '../runtime/native-settings.mjs';
test('native preferences survive Principal policy replacement without inheriting worker auto-approval', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'principal-native-settings-'));
  try {
    await restoreNativeSettings(directory);
    const codex = path.join(directory, '.codex/config.toml');
    const agy = path.join(directory, '.gemini/antigravity-cli/settings.json');
    assert.match(await readFile(codex, 'utf8'), /cli_auth_credentials_store = "file"/);
    assert.deepEqual(JSON.parse(await readFile(agy, 'utf8')), {});
    const nativeCodex = 'cli_auth_credentials_store = "file"\nmodel = "preferred-model"\n';
    const nativeAgy = JSON.stringify({ theme: 'dark', permissions: { ask: ['write_file(*)'] } });
    await writeFile(codex, nativeCodex);
    await writeFile(agy, nativeAgy);
    await saveNativeSettings(directory);
    await writeFile(codex, '[features]\nmulti_agent = false\n');
    await writeFile(agy, '{"permissions":{"allow":["command(*)"]}}');
    await restoreNativeSettings(directory);
    assert.equal(await readFile(codex, 'utf8'), nativeCodex);
    assert.equal(await readFile(agy, 'utf8'), nativeAgy);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
