import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeCursorRefresh } from './cursor-refresh.mjs';

test('delegates cursor refresh to the native Windows bridge', () => {
  let calls = 0;
  const bridge = createNativeCursorRefresh({ platform: 'win32', loadAddon: () => ({
    refreshCursorAtCurrentPoint() { calls++; return { refreshed: true, hitTest: 1, error: 0 }; },
  }) });
  assert.equal(bridge.available, true);
  assert.deepEqual(bridge.refresh(), { refreshed: true, hitTest: 1, error: 0 });
  assert.equal(calls, 1);
});

test('keeps unsupported platforms and missing addons non-fatal', () => {
  assert.equal(createNativeCursorRefresh({ platform: 'linux' }).available, false);
  const missing = createNativeCursorRefresh({ platform: 'win32', loadAddon: () => { throw new Error('missing'); } });
  assert.equal(missing.available, false);
  assert.deepEqual(missing.refresh(), { refreshed: false, error: -1 });
});
