import { realpath, stat } from 'node:fs/promises';
import { managementRpc } from './client.js';
import { defaultDirectory } from './providers.js';
import type { Profile, Snapshot } from './model.js';

/** Discovery runs in the TUI's environment and uses existing daemon operations. */
export async function discoverNativeProfiles(
  request: (method: string, args?: unknown) => Promise<any> = managementRpc,
) {
  const snapshot: Snapshot = await request('snapshot');
  const profiles = [...snapshot.profiles];
  const found: Profile[] = [];
  const skipped: { tool: string; reason: string }[] = [];
  for (const installation of snapshot.installations) {
    if (!installation.executable) continue;
    try {
      const directory = await realpath(defaultDirectory(installation.tool));
      const metadata = await stat(directory);
      if (!metadata.isDirectory() || metadata.uid !== process.getuid?.()) continue;
      const existing = profiles.find(
        (p) => p.tool === installation.tool && p.directory === directory,
      );
      if (existing) {
        found.push(existing);
        continue;
      }
      if (
        snapshot.excludedProfiles?.some(
          (p) => p.tool === installation.tool && p.directory === directory,
        )
      )
        continue;
      let label = `native-${installation.tool}`,
        suffix = 2;
      while (profiles.some((p) => p.label === label))
        label = `native-${installation.tool}-${suffix++}`;
      const profile: Profile | null = await request('profiles.add', {
        tool: installation.tool,
        label,
        isolated: false,
        discovery: true,
        directory,
      });
      if (!profile) continue;
      profiles.push(profile);
      found.push(profile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        skipped.push({ tool: installation.tool, reason: (error as Error).message });
    }
  }
  return {
    profiles: found,
    skipped,
    note: 'Configuration references only; authentication is not inferred from directory presence.',
  };
}
