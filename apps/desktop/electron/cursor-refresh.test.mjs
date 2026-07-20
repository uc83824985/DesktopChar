import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeCursorRefresh } from './cursor-refresh.mjs';

test('delegates cursor refresh to the native Windows bridge', () => {
  const calls = [];
  const target = 123n;
  const bridge = createNativeCursorRefresh({ platform: 'win32', bindings: {
    getCursorPos(point) { point.x = 125; point.y = 90; return 1; },
    windowFromPoint: point => (calls.push(['point', point.x, point.y]), target),
    loadCursor(_instance, name) { calls.push(['loadCursor', name]); return 456n; },
    setCursor(cursor) { calls.push(['setCursor', cursor]); return 1n; },
    sendMessageTimeout(_target, message, wParam, lParam, flags, timeout, output) {
      calls.push(['message', message, wParam, lParam, flags, timeout]);
      output[0] = message === 0x0084 ? 1n : 0n;
      return 1n;
    },
    getLastError: () => 0,
  } });
  assert.equal(bridge.available, true);
  assert.equal(bridge.backend, 'koffi');
  assert.deepEqual(bridge.refresh({ cursor: 'pointer' }), {
    refreshed: true, delivered: true, handled: false, cursorSet: true,
    frameRefreshed: false, cursorNudgeAccepted: false,
    targetIsRequested: false, pointTargetIsRequested: false,
    foregroundIsRequested: false, hitTest: 1, error: 0,
  });
  assert.deepEqual(calls, [
    ['point', 125, 90],
    ['message', 0x0084, 0n, 5898365n, 3, 50],
    ['message', 0x0020, 123n, 33554433n, 3, 50],
    ['loadCursor', 32649n],
    ['setCursor', 456n],
  ]);
});

test('keeps unsupported platforms and missing addons non-fatal', () => {
  assert.equal(createNativeCursorRefresh({ platform: 'linux' }).available, false);
  const missing = createNativeCursorRefresh({ platform: 'win32', koffi: { load() { throw new Error('missing'); } } });
  assert.equal(missing.available, false);
  assert.deepEqual(missing.refresh(), { refreshed: false, error: -1 });
});

test('restores the system arrow when switching back to passthrough', () => {
  const cursorNames = [];
  const bridge = createNativeCursorRefresh({ platform: 'win32', bindings: {
    getCursorPos(point) { point.x = 1; point.y = 2; return 1; },
    windowFromPoint: () => 1n,
    sendMessageTimeout(_target, message, _wParam, _lParam, _flags, _timeout, output) {
      output[0] = message === 0x0084 ? 1n : 0n;
      return 1n;
    },
    loadCursor(_instance, name) { cursorNames.push(name); return 2n; },
    setCursor() { return null; },
    getLastError: () => 0,
  } });
  assert.equal(bridge.refresh({ cursor: 'default' }).cursorSet, true);
  assert.deepEqual(cursorNames, [32512n]);
});

test('maps dragging to the shared move cursor intent', () => {
  const cursorNames = [];
  const bridge = createNativeCursorRefresh({ platform: 'win32', bindings: {
    getCursorPos(point) { point.x = 41; point.y = 73; return 1; },
    windowFromPoint: () => 1n,
    sendMessageTimeout(_target, message, _wParam, _lParam, _flags, _timeout, output) {
      output[0] = message === 0x0084 ? 1n : 0n;
      return 1n;
    },
    loadCursor(_instance, name) { cursorNames.push(name); return 2n; },
    setCursor() { return null; },
    getLastError: () => 0,
  } });
  assert.equal(bridge.refresh({ cursor: 'move' }).cursorSet, true);
  assert.deepEqual(cursorNames, [32646n]);
});

test('refreshes the explicit avatar HWND without activation when stationary coverage enters', () => {
  const calls = [];
  const bridge = createNativeCursorRefresh({ platform: 'win32', bindings: {
    getCursorPos(point) { point.x = 9; point.y = 12; return 1; },
    windowFromPoint: () => 77n,
    getForegroundWindow: () => 88n,
    setWindowPos(...args) { calls.push(['setWindowPos', ...args]); return 1; },
    getSystemMetrics(index) { return ({ 76: -1920, 77: 0, 78: 3840, 79: 1080 })[index]; },
    sendInput(count, input, size) { calls.push(['sendInput', count, input, size]); return 2; },
    inputSize: 40,
    sendMessageTimeout(target, message, wParam, _lParam, _flags, _timeout, output) {
      calls.push(['message', target, message, wParam]);
      output[0] = message === 0x0084 ? 1n : 0n;
      return 1n;
    },
    loadCursor: () => 3n,
    setCursor: () => 4n,
    getLastError: () => 0,
  } });
  const result = bridge.refresh({
    cursor: 'pointer', windowHandle: 99n, refreshFrame: true, nudgeCursor: true,
  });
  assert.equal(result.frameRefreshed, true);
  assert.equal(result.cursorNudgeAccepted, true);
  assert.equal(result.targetIsRequested, true);
  assert.equal(result.pointTargetIsRequested, false);
  assert.equal(result.foregroundIsRequested, false);
  assert.deepEqual(calls[0], ['setWindowPos', 99n, 0n, 0, 0, 0, 0, 0x37]);
  assert.equal(calls[1][0], 'sendInput');
  assert.equal(calls[1][1], 2);
  assert.equal(calls[1][2].length, 2);
  assert.equal(calls[1][2][0].mi.dwFlags, 0xe001);
  assert.equal(calls[1][2][1].mi.dwFlags, 0xe001);
  assert.notEqual(calls[1][2][0].mi.dx, calls[1][2][1].mi.dx);
  assert.equal(calls[1][3], 40);
  assert.deepEqual(calls[2].slice(0, 4), ['message', 99n, 0x0084, 0n]);
  assert.deepEqual(calls[3].slice(0, 4), ['message', 99n, 0x0020, 99n]);
});
