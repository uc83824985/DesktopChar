import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const directory = path.dirname(fileURLToPath(import.meta.url));

export function createNativeCursorRefresh(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return unavailable('not-windows');
  try {
    const addon = options.loadAddon?.() ?? require(path.resolve(directory, '../../../native/cursor-refresh/build/Release/cursor_refresh.node'));
    if (typeof addon.refreshCursorAtCurrentPoint !== 'function') return unavailable('invalid-addon');
    return {
      available: true,
      refresh() { return addon.refreshCursorAtCurrentPoint(); },
    };
  }
  catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

function unavailable(reason) {
  return { available: false, reason, refresh: () => ({ refreshed: false, error: -1 }) };
}
