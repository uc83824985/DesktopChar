import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeWindowPosition } from './native-window-position.mjs';

test('moves a Windows HWND without resizing, activation, Z-order changes, or sync paint', () => {
  const calls = [];
  const mover = createNativeWindowPosition({ platform: 'win32', bindings: {
    setWindowPos(...args) { calls.push(args); return 1; },
    getLastError: () => 0,
  } });
  assert.equal(mover.available, true);
  assert.deepEqual(mover.move(99n, { x: 1_250, y: -80 }), {
    moved: true, error: 0, flags: 0x2615,
  });
  assert.deepEqual(calls, [[99n, 0n, 1_250, -80, 0, 0, 0x2615]]);
});

test('reports native failure and leaves other platforms unavailable', () => {
  const failed = createNativeWindowPosition({ platform: 'win32', bindings: {
    setWindowPos: () => 0,
    getLastError: () => 1400,
  } });
  assert.deepEqual(failed.move(4n, { x: 1, y: 2 }), { moved: false, error: 1400, flags: 0x2615 });
  assert.equal(createNativeWindowPosition({ platform: 'linux' }).available, false);
  assert.throws(() => failed.move(4n, { x: 1.2, y: 2 }), /integer screen point/);
});
