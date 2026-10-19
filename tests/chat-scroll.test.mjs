import test from 'node:test';
import assert from 'node:assert/strict';
import {
  viewportStart,
  moveViewport,
  mouseScroll,
  terminalInputOn,
  terminalInputOff,
} from '../dist/chat-scroll.js';

test('pages move a bounded viewport and reverse immediately after overscrolling either edge', () => {
  let offset = 0;
  assert.equal(viewportStart(30, 5, offset), 0);
  offset = moveViewport(30, 5, offset, 'down', 4);
  assert.equal(viewportStart(30, 5, offset), 4);
  offset = moveViewport(30, 5, offset, 'up', 4);
  assert.equal(offset, 0);
  for (let i = 0; i < 20; i++) offset = moveViewport(30, 5, offset, 'up');
  offset = moveViewport(30, 5, offset, 'down');
  assert.equal(viewportStart(30, 5, offset), 3);
  for (let i = 0; i < 20; i++) offset = moveViewport(30, 5, offset, 'down');
  assert.equal(viewportStart(30, 5, offset), 25);
  assert.equal(viewportStart(30, 5, moveViewport(30, 5, offset, 'up')), 22);
});
test('conversation follows new output until scrolling anchors a row; resized views clamp', () => {
  assert.equal(viewportStart(30, 5, null), 25);
  const anchored = moveViewport(30, 5, null, 'up', 4);
  assert.equal(viewportStart(31, 5, anchored), 21);
  assert.equal(viewportStart(3, 5, anchored), 0);
  assert.equal(moveViewport(30, 5, anchored, 'bottom'), null);
  assert.equal(moveViewport(30, 5, null, 'top'), 0);
});
test('mouse and touchpad wheel reports are recognized; clicks and horizontal motion are consumed', () => {
  assert.equal(mouseScroll('\x1b[<64;20;8M'), 'up');
  assert.equal(mouseScroll('[<65;20;8M'), 'down');
  assert.equal(mouseScroll('[<80;20;8M'), 'up');
  for (const report of ['[<0;2;3M', '[<0;2;3m', '[<66;2;3M', '[<67;2;3M', '[<64;2;3m'])
    assert.equal(mouseScroll(report), null);
  for (const text of ['hello', '/usage', '[<64;2;']) assert.equal(mouseScroll(text), undefined);
  assert.ok(terminalInputOn.includes('[?1006h'));
  assert.ok(terminalInputOff.includes('[?1006l'));
});
