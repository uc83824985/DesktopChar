import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshChromiumCursorAtScreenPoint } from './cursor-refresh.mjs';

test('refreshes Chromium cursor with a zero-delta event at the real local point', () => {
  const events = [];
  const window = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 100, y: 50, width: 460, height: 700 }),
    webContents: { sendInputEvent: event => events.push(event) },
  };
  assert.equal(refreshChromiumCursorAtScreenPoint(window, { x: 125, y: 90 }), true);
  assert.deepEqual(events, [{
    type: 'mouseMove', x: 25, y: 40, globalX: 125, globalY: 90, movementX: 0, movementY: 0,
  }]);
});

test('does not inject cursor events outside the avatar window', () => {
  const events = [];
  const window = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 100, y: 50, width: 460, height: 700 }),
    webContents: { sendInputEvent: event => events.push(event) },
  };
  assert.equal(refreshChromiumCursorAtScreenPoint(window, { x: 99, y: 90 }), false);
  assert.deepEqual(events, []);
});
