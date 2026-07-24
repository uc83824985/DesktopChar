import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeWindowTopmost } from './native-window-topmost.mjs';

test('reads and repairs native topmost state without moving, resizing, or activating', () => {
  let exStyle = 0x00280020n;
  const calls = [];
  const topmost = createNativeWindowTopmost({
    platform: 'win32',
    bindings: {
      isWindow: () => 1,
      getForegroundWindow: () => 123n,
      getWindowLongPtr: () => exStyle,
      setWindowPos(...args) {
        calls.push(args);
        exStyle |= 0x8n;
        return 1;
      },
      getLastError: () => 0,
    },
  });

  assert.deepEqual(topmost.inspect(99n), {
    valid: true,
    topmost: false,
    exStyle: '0x280020',
    error: 0,
  });
  assert.deepEqual(topmost.foreground(), {
    handle: 123n,
    valid: true,
    topmost: false,
    exStyle: '0x280020',
    error: 0,
  });
  assert.deepEqual(topmost.set(99n, true), {
    changed: true,
    topmost: true,
    error: 0,
    flags: 0x0613,
  });
  assert.deepEqual(calls, [[99n, -1n, 0, 0, 0, 0, 0x0613]]);
});

test('does not resubmit a matching native state and reports invalid windows', () => {
  let submissions = 0;
  const matching = createNativeWindowTopmost({
    platform: 'win32',
    bindings: {
      isWindow: () => 1,
      getForegroundWindow: () => 4n,
      getWindowLongPtr: () => 0x8n,
      setWindowPos: () => { submissions += 1; return 1; },
      getLastError: () => 0,
    },
  });
  assert.deepEqual(matching.set(4n, true), {
    changed: false,
    topmost: true,
    error: 0,
    flags: 0x0613,
  });
  assert.equal(submissions, 0);

  const invalid = createNativeWindowTopmost({
    platform: 'win32',
    bindings: {
      isWindow: () => 0,
      getForegroundWindow: () => 0n,
      getWindowLongPtr: () => 0n,
      setWindowPos: () => 0,
      getLastError: () => 1400,
    },
  });
  assert.deepEqual(invalid.set(4n, true), {
    changed: false,
    topmost: null,
    error: 1400,
    flags: 0x0613,
  });
  assert.throws(() => invalid.inspect(0n), /valid HWND/);
  assert.equal(createNativeWindowTopmost({ platform: 'linux' }).available, false);
});
