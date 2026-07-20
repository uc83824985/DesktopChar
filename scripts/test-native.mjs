import assert from 'node:assert/strict';
import { createNativeCursorRefresh } from '../apps/desktop/electron/cursor-refresh.mjs';

const bridge = createNativeCursorRefresh();
if (process.platform === 'win32') {
  assert.equal(bridge.available, true, `native cursor bridge unavailable: ${bridge.reason ?? 'unknown'}`);
  const result = bridge.refresh();
  assert.equal(typeof result.refreshed, 'boolean');
  assert.equal(typeof result.error, 'number');
  console.log('[native] cursor bridge loaded', result);
}
else {
  assert.equal(bridge.available, false);
  console.log('[native] cursor bridge correctly disabled on this platform');
}
