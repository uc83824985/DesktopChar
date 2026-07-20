import koffi from 'koffi';

const WM_NCHITTEST = 0x0084;
const WM_SETCURSOR = 0x0020;
const WM_MOUSEMOVE = 0x0200;
const HTCLIENT = 1;
const SMTO_BLOCK = 0x0001;
const SMTO_ABORTIFHUNG = 0x0002;
const IDC_ARROW = 32512;
const IDC_HAND = 32649;

export function createNativeCursorRefresh(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return unavailable('not-windows');
  try {
    const bindings = options.bindings ?? createKoffiBindings(options.koffi ?? koffi);
    return {
      available: true,
      backend: 'koffi',
      refresh(options) { return refreshCursor(bindings, options); },
    };
  }
  catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

function createKoffiBindings(api) {
  const user32 = api.load('user32.dll');
  const kernel32 = api.load('kernel32.dll');
  const POINT = api.struct('DesktopChar_POINT', { x: 'long', y: 'long' });
  const HWND = api.pointer('DesktopChar_HWND', api.opaque());
  return {
    address: api.address,
    getCursorPos: user32.func('int __stdcall GetCursorPos(_Out_ DesktopChar_POINT *pos)'),
    windowFromPoint: user32.func('DesktopChar_HWND __stdcall WindowFromPoint(DesktopChar_POINT point)'),
    loadCursor: user32.func('DesktopChar_HWND __stdcall LoadCursorW(DesktopChar_HWND hInstance, uintptr_t cursorName)'),
    setCursor: user32.func('DesktopChar_HWND __stdcall SetCursor(DesktopChar_HWND cursor)'),
    sendMessageTimeout: user32.func('intptr_t __stdcall SendMessageTimeoutW(DesktopChar_HWND hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam, uint32_t flags, uint32_t timeout, _Out_ uintptr_t *result)'),
    getLastError: kernel32.func('uint32_t __stdcall GetLastError()'),
    POINT,
    HWND,
  };
}

function refreshCursor(bindings, options = {}) {
  const point = {};
  if (!bindings.getCursorPos(point)) return failure(bindings.getLastError());
  const target = bindings.windowFromPoint(point);
  if (!target) return failure(0);

  const screenPoint = makeLParam(point.x, point.y);
  const hitResult = [BigInt(HTCLIENT)];
  const hitDelivered = bindings.sendMessageTimeout(
    target, WM_NCHITTEST, 0n, screenPoint,
    SMTO_ABORTIFHUNG | SMTO_BLOCK, 50, hitResult,
  );
  if (!hitDelivered) return failure(bindings.getLastError());

  const hitTest = Number(hitResult[0]);
  const cursorResult = [0n];
  const cursorDelivered = bindings.sendMessageTimeout(
    target, WM_SETCURSOR, bindings.address(target), makeLParam(hitTest, WM_MOUSEMOVE),
    SMTO_ABORTIFHUNG | SMTO_BLOCK, 50, cursorResult,
  );
  const cursorHandled = Boolean(cursorResult[0]);
  let cursorSet = false;
  if (typeof options.interactive === 'boolean' && bindings.loadCursor && bindings.setCursor) {
    const cursorName = options.interactive ? IDC_HAND : IDC_ARROW;
    const cursor = bindings.loadCursor(null, BigInt(cursorName));
    if (cursor) {
      bindings.setCursor(cursor);
      // SetCursor returns the previous cursor, which may legitimately be NULL.
      cursorSet = true;
    }
  }
  return {
    refreshed: Boolean(cursorSet || (cursorDelivered && cursorHandled)),
    delivered: Boolean(cursorDelivered),
    handled: cursorHandled,
    cursorSet,
    hitTest,
    error: cursorDelivered ? 0 : bindings.getLastError(),
  };
}

function makeLParam(low, high) {
  return (BigInt(high & 0xffff) << 16n) | BigInt(low & 0xffff);
}

function failure(error) { return { refreshed: false, error: Number(error) }; }

function unavailable(reason) {
  return { available: false, backend: 'unavailable', reason, refresh: () => ({ refreshed: false, error: -1 }) };
}
