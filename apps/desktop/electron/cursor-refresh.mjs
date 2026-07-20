import koffi from 'koffi';

const WM_NCHITTEST = 0x0084;
const WM_SETCURSOR = 0x0020;
const WM_MOUSEMOVE = 0x0200;
const HTCLIENT = 1;
const SMTO_BLOCK = 0x0001;
const SMTO_ABORTIFHUNG = 0x0002;
const SWP_REFRESH_FRAME_NO_ACTIVATE = 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020;
const IDC_ARROW = 32512;
const IDC_HAND = 32649;
const IDC_SIZEALL = 32646;
const CURSOR_RESOURCES = { default: IDC_ARROW, pointer: IDC_HAND, move: IDC_SIZEALL };
const MOUSEEVENTF_REROUTE = 0x0001 | 0x2000 | 0x4000 | 0x8000;

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
  const MOUSEINPUT = api.struct('DesktopChar_MOUSEINPUT', {
    dx: 'long', dy: 'long', mouseData: 'uint32_t', dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t',
  });
  const INPUT = api.struct('DesktopChar_INPUT', { type: 'uint32_t', mi: MOUSEINPUT });
  return {
    getCursorPos: user32.func('int __stdcall GetCursorPos(_Out_ DesktopChar_POINT *pos)'),
    windowFromPoint: user32.func('uintptr_t __stdcall WindowFromPoint(DesktopChar_POINT point)'),
    getForegroundWindow: user32.func('uintptr_t __stdcall GetForegroundWindow()'),
    setWindowPos: user32.func('int __stdcall SetWindowPos(uintptr_t hWnd, uintptr_t hWndInsertAfter, int x, int y, int cx, int cy, uint32_t flags)'),
    getSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int index)'),
    sendInput: user32.func('uint32_t __stdcall SendInput(uint32_t count, DesktopChar_INPUT *inputs, int size)'),
    loadCursor: user32.func('uintptr_t __stdcall LoadCursorW(uintptr_t hInstance, uintptr_t cursorName)'),
    setCursor: user32.func('uintptr_t __stdcall SetCursor(uintptr_t cursor)'),
    sendMessageTimeout: user32.func('intptr_t __stdcall SendMessageTimeoutW(uintptr_t hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam, uint32_t flags, uint32_t timeout, _Out_ uintptr_t *result)'),
    getLastError: kernel32.func('uint32_t __stdcall GetLastError()'),
    POINT,
    inputSize: api.sizeof(INPUT),
  };
}

function refreshCursor(bindings, options = {}) {
  const point = {};
  if (!bindings.getCursorPos(point)) return failure(bindings.getLastError());
  const pointTarget = bindings.windowFromPoint(point);
  const requestedTarget = options.windowHandle ? BigInt(options.windowHandle) : 0n;
  const target = requestedTarget || pointTarget;
  if (!target) return failure(0);

  const frameRefreshed = Boolean(options.refreshFrame && requestedTarget && bindings.setWindowPos(
    requestedTarget, 0n, 0, 0, 0, 0, SWP_REFRESH_FRAME_NO_ACTIVATE,
  ));
  const cursorNudgeAccepted = Boolean(options.nudgeCursor && nudgeCursorInput(bindings, point));

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
    target, WM_SETCURSOR, target, makeLParam(hitTest, WM_MOUSEMOVE),
    SMTO_ABORTIFHUNG | SMTO_BLOCK, 50, cursorResult,
  );
  const cursorHandled = Boolean(cursorResult[0]);
  let cursorSet = false;
  const cursorName = CURSOR_RESOURCES[options.cursor];
  if (cursorName && bindings.loadCursor && bindings.setCursor) {
    const cursor = bindings.loadCursor(0n, BigInt(cursorName));
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
    frameRefreshed,
    cursorNudgeAccepted,
    targetIsRequested: Boolean(requestedTarget && target === requestedTarget),
    pointTargetIsRequested: Boolean(requestedTarget && pointTarget === requestedTarget),
    foregroundIsRequested: Boolean(requestedTarget && bindings.getForegroundWindow() === requestedTarget),
    hitTest,
    error: cursorDelivered ? 0 : bindings.getLastError(),
  };
}

function nudgeCursorInput(bindings, point) {
  const left = bindings.getSystemMetrics(76);
  const top = bindings.getSystemMetrics(77);
  const width = bindings.getSystemMetrics(78);
  const height = bindings.getSystemMetrics(79);
  if (width <= 1 || height <= 1) return false;
  const neighborX = point.x < left + width - 1 ? point.x + 1 : point.x - 1;
  const makeInput = (x, y) => ({
    type: 0,
    mi: {
      dx: Math.round(((x - left) * 65535) / (width - 1)),
      dy: Math.round(((y - top) * 65535) / (height - 1)),
      mouseData: 0,
      dwFlags: MOUSEEVENTF_REROUTE,
      time: 0,
      dwExtraInfo: 0n,
    },
  });
  const inputs = [makeInput(neighborX, point.y), makeInput(point.x, point.y)];
  return bindings.sendInput(inputs.length, inputs, bindings.inputSize) === inputs.length;
}

function makeLParam(low, high) {
  return (BigInt(high & 0xffff) << 16n) | BigInt(low & 0xffff);
}

function failure(error) { return { refreshed: false, error: Number(error) }; }

function unavailable(reason) {
  return { available: false, backend: 'unavailable', reason, refresh: () => ({ refreshed: false, error: -1 }) };
}
