import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const settings = [
  ['.codex/config.toml', 'codex.toml', 'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n'],
  ['.gemini/antigravity-cli/settings.json', 'antigravity.json', '{}\n'],
];
export async function restoreNativeSettings(nativeHome = process.env.HOME ?? '/home/principal') {
  const saved = path.join(nativeHome, '.config/principal/native-settings');
  for (const [relative, backup, initial] of settings) {
    const target = path.join(nativeHome, relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try { await copyFile(path.join(saved, backup), target); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(target, initial, { mode: 0o600 });
    }
  }
}
export async function saveNativeSettings(nativeHome = process.env.HOME ?? '/home/principal') {
  const saved = path.join(nativeHome, '.config/principal/native-settings');
  await mkdir(saved, { recursive: true, mode: 0o700 });
  for (const [relative, backup] of settings) {
    try { await copyFile(path.join(nativeHome, relative), path.join(saved, backup)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await saveNativeSettings();
