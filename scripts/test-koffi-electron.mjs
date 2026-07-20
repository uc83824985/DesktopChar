import assert from 'node:assert/strict';
import { createNativeCursorRefresh } from '../apps/desktop/electron/cursor-refresh.mjs';

const bridge = createNativeCursorRefresh();
if (process.platform === 'win32') {
  assert.equal(bridge.available, true, `Koffi Win32 bridge unavailable: ${bridge.reason ?? 'unknown'}`);
  assert.equal(bridge.backend, 'koffi');
  const result = bridge.refresh({ interactive: true });
  assert.equal(result.refreshed, true);
  assert.equal(result.cursorSet, true);
  assert.equal(typeof result.error, 'number');
  console.log('[koffi] Electron Win32 bridge loaded', result);
}
else assert.equal(bridge.available, false);
