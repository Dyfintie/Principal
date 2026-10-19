import test from 'node:test';
import assert from 'node:assert/strict';
import { inputPreview } from '../dist/chat-input.js';

test('input cursor follows typed text and remains inside the box on long lines', () => {
  assert.deepEqual(inputPreview('', 80), { lines: [''], cursorColumn: 4 });
  assert.deepEqual(inputPreview('hello', 80), { lines: ['hello'], cursorColumn: 9 });
  const long = inputPreview('x'.repeat(100) + 'end', 20);
  assert.ok(long.lines[0].endsWith('end'));
  assert.equal(long.lines[0].length, 13);
  assert.equal(long.cursorColumn, 17);
});
test('multiline and Unicode previews keep whole graphemes and use terminal cell widths', () => {
  assert.deepEqual(inputPreview('first\nsecond\nlast', 80), {
    lines: ['second', 'last'],
    cursorColumn: 8,
  });
  assert.deepEqual(inputPreview('你好', 80), { lines: ['你好'], cursorColumn: 8 });
  assert.deepEqual(inputPreview('e\u0301', 80), { lines: ['e\u0301'], cursorColumn: 5 });
  assert.equal(inputPreview('👩‍💻', 80).cursorColumn, 6);
  assert.deepEqual(inputPreview('hello\n', 80), { lines: ['hello', ''], cursorColumn: 4 });
});
