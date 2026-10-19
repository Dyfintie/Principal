import test from 'node:test';
import assert from 'node:assert/strict';
import { managementSuggestions, managementCommands } from '../dist/management/slash.js';
import { launchMultipleAgents } from '../dist/management/launcher.js';

test('management commands list contains primary actions and clean suggestions', () => {
  const all = managementCommands.map((c) => c.command);
  assert(all.includes('/launch'));
  assert(all.includes('/swap'));
  assert(all.includes('/usage'));
  assert(all.includes('/profiles'));
  assert(all.includes('/sessions'));
  assert(all.includes('/doctor'));
  assert(all.includes('/help'));
  assert(all.includes('/exit'));

  // Autocomplete suggestions
  assert(managementSuggestions('/').some((c) => c.command === '/launch'));
  assert(managementSuggestions('/').some((c) => c.command === '/accounts'));
  assert.deepEqual(
    managementSuggestions('/la').map((c) => c.command),
    ['/launch'],
  );
  assert.deepEqual(
    managementSuggestions('/sw').map((c) => c.command),
    ['/swap', '/switch'],
  );
});

test('launchMultipleAgents rejects empty profile lists and handles invalid profiles', async () => {
  await assert.rejects(
    () => launchMultipleAgents([]),
    /Specify at least one profile to launch/,
  );

  await assert.rejects(
    () => launchMultipleAgents(['non_existent_profile_xyz_123', 'non_existent_profile_xyz_456']),
    /Profile 'non_existent_profile_xyz_123' not found/,
  );
});

test('launchMultipleAgents handles comma-separated profile strings', async () => {
  await assert.rejects(
    () => launchMultipleAgents(['p_unknown1, p_unknown2']),
    /Profile 'p_unknown1' not found/,
  );
});
