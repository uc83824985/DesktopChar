import koffi from 'koffi';

const WM_NCHITTEST = 0x0084;
const WM_SETCURSOR = 0x0020;
const WM_MOUSEMOVE = 0x0200;
const HTCLIENT = 1;
const SMTO_BLOCK = 0x0001;
const SMTO_ABORTIFHUNG = 0x0002;

export function createNativeCursorRefresh(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return unavailable('not-windows');
  try {
    const bindings = options.bindings ?? createKoffiBindings(options.koffi ?? koffi);
    return {
      available: true,
      backend: 'koffi',
      refresh() { return refreshCursor(bindings); },
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
    sendMessageTimeout: user32.func('intptr_t __stdcall SendMessageTimeoutW(DesktopChar_HWND hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam, uint32_t flags, uint32_t timeout, _Out_ uintptr_t *result)'),
    getLastError: kernel32.func('uint32_t __stdcall GetLastError()'),
    POINT,
    HWND,
  };
}

function refreshCursor(bindings) {
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
  return {
    refreshed: Boolean(cursorDelivered),
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
