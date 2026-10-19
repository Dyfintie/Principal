import { constants } from 'node:fs';
import { lstat, open, realpath, mkdtemp, mkdir, writeFile, rm, link } from 'node:fs/promises';
import path from 'node:path';
import { compatiblePatch } from './compatibility.js';
import { codexRead, codexForkSnapshot } from './codex.js';
import { managementPaths, privateDirectory } from './paths.js';
import { NativeId, type Profile, type Installation } from './model.js';

const maximumBytes = 64 * 1024 * 1024;
function inside(directory: string, file: string) {
  return file.startsWith(directory + path.sep);
}
async function readRollout(home: string, file: string) {
  const canonical = await realpath(file);
  if (
    canonical !== file ||
    !file.endsWith('.jsonl') ||
    !['sessions', 'archived_sessions'].some((dir) => inside(path.join(home, dir), file))
  )
    throw new Error('Conversation must be a local, regular Codex history file in this profile');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || before.size > maximumBytes)
      throw new Error('Conversation file is unsafe or exceeds the 64 MiB copy limit');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.length > maximumBytes ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('Conversation changed during copying; finish the turn and try again');
    if (!bytes.length || bytes[bytes.length - 1] !== 10)
      throw new Error('Conversation has an incomplete record; finish the turn and try again');
    let records: any[];
    try {
      records = bytes
        .toString('utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
    } catch {
      throw new Error('Malformed native conversation history; nothing was copied');
    }
    if (records[0]?.type !== 'session_meta')
      throw new Error('Unsupported Codex conversation format');
    let active = false;
    for (const r of records) {
      if (r.type !== 'event_msg') continue;
      if (r.payload?.type === 'task_started') active = true;
      if (['task_complete', 'turn_aborted'].includes(r.payload?.type)) active = false;
    }
    if (active) throw new Error('Finish the source conversation’s turn before copying');
    return { bytes, records };
  } finally {
    await handle.close();
  }
}
async function historyDirectory(home: string) {
  let directory = home;
  const now = new Date();
  for (const component of [
    'sessions',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ]) {
    directory = path.join(directory, component);
    await mkdir(directory, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const s = await lstat(directory);
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      s.uid !== process.getuid?.() ||
      (await realpath(directory)) !== directory
    )
      throw new Error('Destination history directory must be owned by this user without symlinks');
  }
  return directory;
}

/** Preserve a complete local rollout under a new native fork identity. */
export async function copyCodexConversation(
  source: Profile,
  target: Profile,
  installation: Installation,
  nativeId: string,
  cwd: string,
) {
  if (source.tool !== 'codex' || target.tool !== 'codex')
    throw new Error('Exact conversation copying currently supports Codex profiles only');
  if (source.id === target.id || source.directory === target.directory)
    throw new Error('Choose a different destination profile');
  if (
    !installation.verifiedVersion ||
    (!compatiblePatch(installation.version, '0.162.1') &&
      !compatiblePatch(installation.version, '0.163.0'))
  )
    throw new Error(
      'Conversation copying requires the supported Codex patch family starting at 0.162.1 and a compatible native history contract',
    );
  for (const profile of [source, target]) {
    const metadata = await lstat(profile.directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid?.() ||
      (await realpath(profile.directory)) !== profile.directory
    )
      throw new Error('Profile directory must be owned by this user without symlinks');
  }
  NativeId.parse(nativeId);
  const [read] = await codexRead(source, installation, [
    { method: 'thread/read', params: { threadId: nativeId, includeTurns: false } },
  ]);
  const original = read?.thread;
  if (
    original?.id !== nativeId ||
    !['legacy', 'paginated'].includes(original.historyMode) ||
    typeof original.path !== 'string'
  )
    throw new Error(
      'This conversation storage format cannot be copied exactly yet; a complete local legacy or paginated JSONL rollout is required',
    );
  if (original.modelProvider !== 'openai')
    throw new Error('Exact copying of custom model-provider conversations is not validated');
  if (original.status?.type === 'active')
    throw new Error('Finish the source conversation’s turn before copying');
  const snapshot = await readRollout(source.directory, original.path);
  if (
    original.historyMode === 'paginated' &&
    snapshot.records[0].payload?.history_mode !== 'paginated'
  )
    throw new Error('Paginated history metadata does not match the local rollout');
  if (snapshot.records[0].payload?.id !== nativeId)
    throw new Error('Conversation identity does not match its history file');
  await privateDirectory(managementPaths.state);
  const stage = await mkdtemp(path.join(managementPaths.state, 'history-copy-'));
  let published: string | null = null;
  try {
    await mkdir(path.join(stage, 'sessions'), { mode: 0o700 });
    // No user configuration, credentials, plugins or keyring are imported.
    await writeFile(
      path.join(stage, 'config.toml'),
      'cli_auth_credentials_store = "file"\nmodel_provider = "openai"\n',
      { mode: 0o600 },
    );
    const paginated = original.historyMode === 'paginated';
    // The app-server cannot fork paginated mode in this version. Change only the
    // temporary metadata header so it can allocate an official fork identity.
    // The original rollout and all non-header bytes remain untouched.
    const body = snapshot.bytes.subarray(snapshot.bytes.indexOf(10) + 1);
    const staged = paginated
      ? Buffer.concat([
          Buffer.from(
            JSON.stringify({
              ...snapshot.records[0],
              payload: { ...snapshot.records[0].payload, history_mode: 'legacy' },
            }) + '\n',
          ),
          body,
        ])
      : snapshot.bytes;
    await writeFile(path.join(stage, 'sessions', path.basename(original.path)), staged, {
      mode: 0o600,
    });
    const [result] = await codexForkSnapshot(stage, installation, nativeId, cwd);
    const fork = result?.thread;
    if (
      !fork ||
      !NativeId.safeParse(fork.id).success ||
      fork.id === nativeId ||
      fork.historyMode !== 'legacy' ||
      fork.forkedFromId !== nativeId ||
      typeof fork.path !== 'string'
    )
      throw new Error('Codex did not return a supported independent conversation fork');
    let copied = await readRollout(stage, fork.path);
    if (copied.records[0].payload?.id !== fork.id)
      throw new Error('Fork identity does not match its local rollout');
    // Native reserialization can discard fields even when loading legacy copies
    // of newer records. Use only its fresh metadata identity, and preserve every
    // original history-body byte for both initial loading and subsequent copies.
    const header = copied.bytes.subarray(0, copied.bytes.indexOf(10) + 1);
    await writeFile(fork.path, Buffer.concat([header, body]), { mode: 0o600 });
    copied = await readRollout(stage, fork.path);
    if (!copied.bytes.subarray(copied.bytes.indexOf(10) + 1).equals(body))
      throw new Error('Complete rollout was not preserved exactly; nothing was copied');
    const destination = path.join(
      await historyDirectory(target.directory),
      path.basename(fork.path),
    );
    const temporary = path.join(path.dirname(destination), `.principal-copy-${fork.id}.tmp`);
    const output = await open(temporary, 'wx', 0o600);
    try {
      try {
        await output.writeFile(copied.bytes);
        await output.sync();
      } finally {
        await output.close();
      }
      // Publish a complete file atomically without replacing existing history.
      await link(temporary, destination);
      published = destination;
    } finally {
      await rm(temporary, { force: true });
    }
    const [verified] = await codexRead(target, installation, [
      { method: 'thread/read', params: { threadId: fork.id, includeTurns: false } },
    ]);
    if (verified?.thread?.id !== fork.id || verified.thread.path !== destination)
      throw new Error('Destination profile did not recognize the copied conversation');
    return { nativeId: fork.id, path: destination, sourceNativeId: nativeId };
  } catch (error) {
    if (published) await rm(published, { force: true });
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
