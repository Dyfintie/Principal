import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'principal-account-handoff-test-'));
process.env.XDG_STATE_HOME = path.join(root, 'state');
process.env.XDG_RUNTIME_DIR = path.join(root, 'runtime');

const { initManagementPaths } = await import('../dist/management/paths.js');
await initManagementPaths();
const { ManagementStore } = await import('../dist/management/store.js');
const { ManagementService } = await import('../dist/management/service.js');
const { environment } = await import('../dist/management/paths.js');
const {
  maskEmail,
  encryptPayload,
  decryptPayload,
  extractScopedCredentials,
  createHandoffBundle,
  parseAndValidateBundle,
  parseDurationToHours,
} = await import('../dist/management/account-handoff.js');
const { processIdentity } = await import('../dist/management/process.js');

test.after(async () => rm(root, { recursive: true, force: true }));

test('maskEmail obfuscates email addresses and usernames for privacy', () => {
  assert.equal(maskEmail('v08pandey@gmail.com'), 'v***y@gmail.com');
  assert.equal(maskEmail('alice@example.com'), 'a***e@example.com');
  assert.equal(maskEmail('ab@test.com'), 'a*@test.com');
  assert.equal(maskEmail('username123'), 'us***23');
});

test('encryptPayload and decryptPayload round-trip using AES-256-GCM', () => {
  const secret = JSON.stringify({ token: 'test-oauth-token-xyz', refresh: 'secret-refresh-123' });
  const passphrase = 'my-super-secret-passphrase';

  const encrypted = encryptPayload(secret, passphrase);
  assert.ok(encrypted.ciphertext);
  assert.ok(encrypted.salt);
  assert.ok(encrypted.iv);
  assert.ok(encrypted.authTag);

  const decrypted = decryptPayload(
    encrypted.ciphertext,
    passphrase,
    encrypted.salt,
    encrypted.iv,
    encrypted.authTag,
  );
  assert.equal(decrypted, secret);

  // Fails with incorrect passphrase
  assert.throws(() => {
    decryptPayload(
      encrypted.ciphertext,
      'wrong-passphrase',
      encrypted.salt,
      encrypted.iv,
      encrypted.authTag,
    );
  });
});

test('createHandoffBundle and parseAndValidateBundle support unencrypted & encrypted armored tokens', async () => {
  const mockDir = path.join(root, 'mock-agy-profile');
  await mkdir(mockDir, { recursive: true });
  const tokenData = {
    token: { access_token: 'acc-123', refresh_token: 'ref-456', expiry: '2026-10-18T00:00:00Z' },
    auth_method: 'oauth',
    id_token: 'header.eyJlbWFpbCI6ICJ2MDhwYW5kZXlAZ21haWwuY29tIn0.sig',
  };
  await writeFile(path.join(mockDir, 'antigravity-oauth-token'), JSON.stringify(tokenData));

  const mockProfile = {
    id: 'test-profile-agy-1',
    tool: 'antigravity',
    label: 'my-antigravity',
    directory: mockDir,
    isolated: false,
    createdAt: new Date().toISOString(),
    auth: 'authenticated',
    authObservedAt: null,
    reportedAccount: 'v08pandey@gmail.com',
    plan: null,
  };

  // 1. Unencrypted bundle
  const unencrypted = await createHandoffBundle(mockProfile, { customLabel: 'friend-agy' });
  assert.ok(unencrypted.armoredToken.startsWith('PRINCIPAL-HANDOFF:v1:'));
  assert.equal(unencrypted.bundle.encrypted, false);
  assert.equal(unencrypted.emailHint, 'v***y@gmail.com');

  const parsedUnencrypted = parseAndValidateBundle(unencrypted.armoredToken);
  assert.equal(parsedUnencrypted.bundle.label, 'friend-agy');
  assert.equal(parsedUnencrypted.bundle.tool, 'antigravity');
  assert.deepEqual(parsedUnencrypted.credentialsPayload, tokenData);

  // 2. Encrypted bundle with passphrase
  const encrypted = await createHandoffBundle(mockProfile, {
    passphrase: 'passphrase-456',
    customLabel: 'secure-agy',
  });
  assert.equal(encrypted.bundle.encrypted, true);
  assert.ok(encrypted.armoredToken.startsWith('PRINCIPAL-HANDOFF:v1:'));

  // Fails to parse encrypted without passphrase
  assert.throws(() => {
    parseAndValidateBundle(encrypted.armoredToken);
  }, /encrypted with a passphrase/);

  // Succeeds with valid passphrase
  const parsedEncrypted = parseAndValidateBundle(encrypted.armoredToken, 'passphrase-456');
  assert.equal(parsedEncrypted.bundle.label, 'secure-agy');
  assert.deepEqual(parsedEncrypted.credentialsPayload, tokenData);
});

test('service.exportAccountHandoff and service.importAccountHandoff execute full end-to-end flow', async () => {
  const store = new ManagementStore(':memory:');
  const service = new ManagementService(store, await environment());
  service.installations = [
    {
      tool: 'antigravity',
      version: '1.3.3',
      executable: '/usr/bin/agy',
      capabilities: {
        launch: { supported: true, confidence: 'official', reason: 'native' },
        history: { supported: true, confidence: 'official', reason: 'native' },
        resume: { supported: true, confidence: 'official', reason: 'native' },
        observer: { supported: true, confidence: 'official', reason: 'native' },
        configurationIsolation: { supported: true, confidence: 'official', reason: 'native' },
      },
    },
    {
      tool: 'codex',
      version: '0.163.0',
      executable: '/usr/bin/codex',
      capabilities: {
        launch: { supported: true, confidence: 'official', reason: 'native' },
        history: { supported: true, confidence: 'official', reason: 'native' },
        resume: { supported: true, confidence: 'official', reason: 'native' },
        observer: { supported: true, confidence: 'official', reason: 'native' },
        configurationIsolation: { supported: true, confidence: 'official', reason: 'native' },
      },
    },
  ];

  // Set up source Codex profile
  const sourceCodexDir = path.join(root, 'source-codex');
  await mkdir(sourceCodexDir, { recursive: true });
  const codexAuth = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { access_token: 'codex-access-token', refresh_token: 'codex-refresh-token' },
  };
  await writeFile(path.join(sourceCodexDir, 'auth.json'), JSON.stringify(codexAuth));

  const sourceProfile = await service.addProfile({
    tool: 'codex',
    label: 'owner-codex',
    directory: sourceCodexDir,
    isolated: false,
  });
  assert.ok(sourceProfile);

  // 1. Export handoff from source profile
  const exportResult = await service.exportAccountHandoff({
    profile: sourceProfile.id,
    passphrase: 'friend-password-789',
    label: 'friend-codex-account',
    copyToClipboard: false,
  });

  assert.ok(exportResult.armoredToken.startsWith('PRINCIPAL-HANDOFF:v1:'));
  assert.equal(exportResult.tool, 'codex');

  // 2. Import handoff on (simulated) recipient instance
  const importResult = await service.importAccountHandoff({
    data: exportResult.armoredToken,
    passphrase: 'friend-password-789',
    label: 'varun-shared-codex',
  });

  assert.equal(importResult.label, 'varun-shared-codex');
  assert.equal(importResult.tool, 'codex');
  assert.ok(importResult.directory);

  // Verify the imported profile has auth.json written in its isolated directory
  const importedAuth = JSON.parse(await readFile(path.join(importResult.directory, 'auth.json'), 'utf8'));
  assert.deepEqual(importedAuth, codexAuth);

  // Verify the profile is registered in store as authenticated
  const storedProfile = store.profiles().find((p) => p.id === importResult.profile.id);
  assert.ok(storedProfile);
  assert.equal(storedProfile.auth, 'authenticated');
  assert.equal(storedProfile.isolated, true);
});

test('service.exportAccountHandoff and service.importAccountHandoff support Antigravity profiles', async () => {
  const store = new ManagementStore(':memory:');
  const service = new ManagementService(store, await environment());
  service.installations = [
    {
      tool: 'antigravity',
      version: '1.3.3',
      executable: '/usr/bin/agy',
      capabilities: {
        launch: { supported: true, confidence: 'official', reason: 'native' },
        history: { supported: true, confidence: 'official', reason: 'native' },
        resume: { supported: true, confidence: 'official', reason: 'native' },
        observer: { supported: true, confidence: 'official', reason: 'native' },
        configurationIsolation: { supported: true, confidence: 'official', reason: 'native' },
      },
    },
  ];

  const sourceProfile = await service.addProfile({
    tool: 'antigravity',
    label: 'owner-antigravity',
    isolated: true,
  });
  assert.ok(sourceProfile);

  const agyToken = {
    token: { access_token: 'google-oauth-acc', refresh_token: 'google-oauth-ref', expiry: '2026-10-18T00:00:00Z' },
    auth_method: 'oauth',
    id_token: 'hdr.eyJlbWFpbCI6ICJ1c2VyQGdtYWlsLmNvbSJ9.sig',
  };
  await writeFile(path.join(sourceProfile.directory, 'antigravity-oauth-token'), JSON.stringify(agyToken));

  // Export
  const exported = await service.exportAccountHandoff({
    profile: sourceProfile.id,
    label: 'friend-antigravity',
  });
  assert.ok(exported.armoredToken.startsWith('PRINCIPAL-HANDOFF:v1:'));
  assert.equal(exported.tool, 'antigravity');
  assert.equal(exported.accountHint, 'u***r@gmail.com');

  // Import
  const imported = await service.importAccountHandoff({
    data: exported.armoredToken,
    label: 'varun-shared-agy',
  });

  assert.equal(imported.label, 'varun-shared-agy');
  assert.equal(imported.tool, 'antigravity');
  assert.ok(imported.directory);

  const importedToken = JSON.parse(await readFile(path.join(imported.directory, 'antigravity-oauth-token'), 'utf8'));
  assert.deepEqual(importedToken, agyToken);

  const storedProfile = store.profiles().find((p) => p.id === imported.profile.id);
  assert.ok(storedProfile);
  assert.equal(storedProfile.auth, 'authenticated');
  assert.equal(storedProfile.reportedAccount, 'u***r@gmail.com');
});

test('parseDurationToHours parses human-friendly durations accurately', () => {
  assert.equal(parseDurationToHours('4h'), 4);
  assert.equal(parseDurationToHours('4 hours'), 4);
  assert.equal(parseDurationToHours('30m'), 0.5);
  assert.equal(parseDurationToHours('1d'), 24);
  assert.equal(parseDurationToHours('2.5h'), 2.5);
  assert.equal(parseDurationToHours(12), 12);

  assert.throws(() => parseDurationToHours('invalid'), /Invalid duration format/);
  assert.throws(() => parseDurationToHours(-5), /positive number of hours/);
});

test('createHandoffBundle embeds time and quota constraints with tamper-resistance', async () => {
  const mockDir = path.join(root, 'mock-agy-constraints');
  await mkdir(mockDir, { recursive: true });
  const tokenData = {
    token: { access_token: 'acc-constraints', refresh_token: 'ref-constraints', expiry: '2026-10-18T00:00:00Z' },
    auth_method: 'oauth',
    id_token: 'hdr.eyJlbWFpbCI6ICJmMWdAbWFpbC5jb20ifQ.sig',
  };
  await writeFile(path.join(mockDir, 'antigravity-oauth-token'), JSON.stringify(tokenData));

  const mockProfile = {
    id: 'profile-f1',
    tool: 'antigravity',
    label: 'f1-account',
    directory: mockDir,
    isolated: false,
    createdAt: new Date().toISOString(),
    auth: 'authenticated',
    authObservedAt: null,
    reportedAccount: 'f1@example.com',
    plan: null,
  };

  const { armoredToken, constraints } = await createHandoffBundle(mockProfile, {
    passphrase: 'super-passphrase',
    timeLimitHours: 6,
    quotaLimitPercent: 20,
    baselineQuotaRemaining: 85,
    allowedQuotaFloor: 65,
  });

  assert.ok(armoredToken.startsWith('PRINCIPAL-HANDOFF:v1:'));
  assert.equal(constraints.timeLimitHours, 6);
  assert.equal(constraints.quotaLimitPercent, 20);
  assert.equal(constraints.baselineQuotaRemaining, 85);
  assert.equal(constraints.allowedQuotaFloor, 65);
  assert.ok(constraints.expiresAt);

  // Decrypt and verify constraints match
  const parsed = parseAndValidateBundle(armoredToken, 'super-passphrase');
  assert.equal(parsed.constraints.timeLimitHours, 6);
  assert.equal(parsed.constraints.allowedQuotaFloor, 65);
  assert.deepEqual(parsed.credentialsPayload, tokenData);

  // Tampering with payload ciphertext fails GCM decryption
  const rawBundle = JSON.parse(Buffer.from(armoredToken.replace('PRINCIPAL-HANDOFF:v1:', ''), 'base64').toString('utf8'));
  rawBundle.payload = rawBundle.payload.slice(0, -4) + 'AAAA';
  const tamperedToken = `PRINCIPAL-HANDOFF:v1:${Buffer.from(JSON.stringify(rawBundle)).toString('base64')}`;

  assert.throws(() => {
    parseAndValidateBundle(tamperedToken, 'super-passphrase');
  }, /Failed to decrypt handoff bundle/);
});

test('service.prepare enforces pre-launch handoff constraints and scrubs expired credentials', async () => {
  const store = new ManagementStore(':memory:');
  const service = new ManagementService(store, await environment());
  service.installations = [
    {
      tool: 'antigravity',
      version: '1.3.3',
      executable: '/usr/bin/agy',
      capabilities: {
        launch: { supported: true, confidence: 'official', reason: 'native' },
        history: { supported: true, confidence: 'official', reason: 'native' },
        resume: { supported: true, confidence: 'official', reason: 'native' },
        observer: { supported: true, confidence: 'official', reason: 'native' },
        configurationIsolation: { supported: true, confidence: 'official', reason: 'native' },
      },
    },
  ];

  const dir1 = path.join(root, 'time-expired-prof');
  await mkdir(dir1, { recursive: true });
  await writeFile(path.join(dir1, 'antigravity-oauth-token'), JSON.stringify({ token: 'active' }));

  // 1. Time-expired profile
  const expiredProfile = store.put('profile', {
    id: 'prof-expired-1',
    tool: 'antigravity',
    label: 'expired-agy',
    directory: dir1,
    isolated: false,
    createdAt: new Date().toISOString(),
    auth: 'authenticated',
    authObservedAt: null,
    reportedAccount: 'f2@example.com',
    plan: null,
    handoffConstraints: {
      timeLimitHours: 4,
      expiresAt: new Date(Date.now() - 3600_000).toISOString(),
      status: 'active',
    },
  });

  const wrapper = await processIdentity(process.pid);
  await assert.rejects(
    async () => {
      await service.prepare({
        profile: expiredProfile.id,
        directory: root,
        wrapper,
      });
    },
    /Account handoff expired: time limit \(4h\) ended/,
  );

  const scrubbedContent = await readFile(path.join(dir1, 'antigravity-oauth-token'), 'utf8');
  assert.equal(scrubbedContent.trim(), '{}');
  const updatedProf = store.profile(expiredProfile.id);
  assert.equal(updatedProf.auth, 'unauthenticated');
  assert.equal(updatedProf.handoffConstraints.status, 'time-expired');

  // 2. Quota floor reached profile
  const dir2 = path.join(root, 'quota-exhausted-prof');
  await mkdir(dir2, { recursive: true });
  await writeFile(path.join(dir2, 'antigravity-oauth-token'), JSON.stringify({ token: 'active' }));

  const quotaProfile = store.put('profile', {
    id: 'prof-quota-1',
    tool: 'antigravity',
    label: 'quota-agy',
    directory: dir2,
    isolated: false,
    createdAt: new Date().toISOString(),
    auth: 'authenticated',
    authObservedAt: null,
    reportedAccount: 'f2@example.com',
    plan: null,
    handoffConstraints: {
      quotaLimitPercent: 20,
      baselineQuotaRemaining: 80,
      allowedQuotaFloor: 60,
      status: 'active',
    },
  });

  store.put('resource', {
    id: 'res-quota-1',
    profileId: quotaProfile.id,
    metric: 'quota-remaining',
    bucket: 'gemini-weekly',
    value: 55,
    unit: 'percent',
    source: 'native',
    sourceKind: 'official',
    observedAt: new Date().toISOString(),
  });

  await assert.rejects(
    async () => {
      await service.prepare({
        profile: quotaProfile.id,
        directory: root,
        wrapper,
      });
    },
    /Account handoff quota limit reached: owner allocated 20% of weekly quota/,
  );

  const scrubbedQuotaContent = await readFile(path.join(dir2, 'antigravity-oauth-token'), 'utf8');
  assert.equal(scrubbedQuotaContent.trim(), '{}');
  const updatedQuotaProf = store.profile(quotaProfile.id);
  assert.equal(updatedQuotaProf.auth, 'unauthenticated');
  assert.equal(updatedQuotaProf.handoffConstraints.status, 'quota-exhausted');
});

test('service.observe stops active invocation and scrubs credentials when quota floor is breached in-flight', async () => {
  const store = new ManagementStore(':memory:');
  const service = new ManagementService(store, await environment());
  service.installations = [
    {
      tool: 'antigravity',
      version: '1.3.3',
      executable: '/usr/bin/agy',
      capabilities: {
        launch: { supported: true, confidence: 'official', reason: 'native' },
        history: { supported: true, confidence: 'official', reason: 'native' },
        resume: { supported: true, confidence: 'official', reason: 'native' },
        observer: { supported: true, confidence: 'official', reason: 'native' },
        configurationIsolation: { supported: true, confidence: 'official', reason: 'native' },
      },
    },
  ];

  const dir = path.join(root, 'inflight-prof');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'antigravity-oauth-token'), JSON.stringify({ token: 'inflight-secret' }));

  const profile = store.put('profile', {
    id: 'prof-inflight-1',
    tool: 'antigravity',
    label: 'inflight-agy',
    directory: dir,
    isolated: false,
    createdAt: new Date().toISOString(),
    auth: 'authenticated',
    authObservedAt: null,
    reportedAccount: 'f2@example.com',
    plan: null,
    handoffConstraints: {
      quotaLimitPercent: 25,
      baselineQuotaRemaining: 80,
      allowedQuotaFloor: 55,
      status: 'active',
    },
  });

  const entry = store.put('entry', {
    id: 'entry-inflight-1',
    profileId: profile.id,
    tool: 'antigravity',
    folderId: 'unassigned',
    projectId: 'proj-1',
    title: 'active session',
    createdAt: new Date().toISOString(),
    archivedAt: null,
    conversationId: null,
  });

  const invId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
  const invocation = store.put('invocation', {
    id: invId,
    entryId: entry.id,
    profileId: profile.id,
    owned: true,
    lifecycle: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    connection: 'connected',
    observedAt: new Date().toISOString(),
    stopRequestedAt: null,
    identity: await processIdentity(process.pid),
    wrapper: await processIdentity(process.pid),
    hasControllingTerminal: false,
    reportedAccount: 'f2@example.com',
  });

  let stopRequested = false;
  service.stop = async (id) => {
    if (id === invocation.id) stopRequested = true;
    return { requested: true };
  };

  await service.observe({
    tool: 'antigravity',
    invocationId: invocation.id,
    ancestorPids: [process.pid],
    account: 'f2@example.com',
    resources: [
      {
        metric: 'quota-remaining',
        bucket: 'gemini-weekly',
        value: 50,
        unit: 'percent',
        resetsAt: new Date().toISOString(),
        source: 'native',
        sourceKind: 'official',
      },
    ],
  });

  assert.equal(stopRequested, true, 'Invocation must be stopped when quota floor is breached');
  const updatedProf = store.profile(profile.id);
  assert.equal(updatedProf.auth, 'unauthenticated');
  assert.equal(updatedProf.handoffConstraints.status, 'quota-exhausted');
  const scrubbed = await readFile(path.join(dir, 'antigravity-oauth-token'), 'utf8');
  assert.equal(scrubbed.trim(), '{}');
});
