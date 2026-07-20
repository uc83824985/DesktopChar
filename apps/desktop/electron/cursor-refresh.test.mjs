import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeCursorRefresh } from './cursor-refresh.mjs';

test('delegates cursor refresh to the native Windows bridge', () => {
  const calls = [];
  const target = {};
  const bridge = createNativeCursorRefresh({ platform: 'win32', bindings: {
    getCursorPos(point) { point.x = 125; point.y = 90; return 1; },
    windowFromPoint: point => (calls.push(['point', point.x, point.y]), target),
    sendMessageTimeout(_target, message, wParam, lParam, flags, timeout, output) {
      calls.push(['message', message, wParam, lParam, flags, timeout]);
      output[0] = message === 0x0084 ? 1n : 0n;
      return 1n;
    },
    address: () => 123n,
    getLastError: () => 0,
  } });
  assert.equal(bridge.available, true);
  assert.equal(bridge.backend, 'koffi');
  assert.deepEqual(bridge.refresh(), { refreshed: true, hitTest: 1, error: 0 });
  assert.deepEqual(calls, [
    ['point', 125, 90],
    ['message', 0x0084, 0n, 5898365n, 3, 50],
    ['message', 0x0020, 123n, 33554433n, 3, 50],
  ]);
});

test('keeps unsupported platforms and missing addons non-fatal', () => {
  assert.equal(createNativeCursorRefresh({ platform: 'linux' }).available, false);
  const missing = createNativeCursorRefresh({ platform: 'win32', koffi: { load() { throw new Error('missing'); } } });
  assert.equal(missing.available, false);
  assert.deepEqual(missing.refresh(), { refreshed: false, error: -1 });
});
