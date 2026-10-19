import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCommands, commandSuggestions } from '../dist/chat-commands.js';

test('slash command suggestions filter prefixes and stop after arguments or normal chat', () => {
  assert.equal(commandSuggestions('/').length, chatCommands.length);
  assert.deepEqual(
    commandSuggestions('/po').map((c) => c.name),
    ['/pool', '/pools'],
  );
  assert.deepEqual(
    commandSuggestions('/a').map((c) => c.name),
    chatCommands.filter((c) => c.name.startsWith('/a')).map((c) => c.name),
  );
  for (const input of ['hello /pool', '/pool development', '/pool ', '/unknown', '/\n'])
    assert.deepEqual(commandSuggestions(input), []);
  assert.ok(chatCommands.every((command) => command.description));
});
