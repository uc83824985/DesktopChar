import koffi from 'koffi';

const SWP_NOSIZE = 0x0001;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOOWNERZORDER = 0x0200;
const SWP_NOSENDCHANGING = 0x0400;
const SWP_DEFERERASE = 0x2000;
const POSITION_ONLY_FLAGS = SWP_NOSIZE
  | SWP_NOZORDER
  | SWP_NOACTIVATE
  | SWP_NOOWNERZORDER
  | SWP_NOSENDCHANGING
  | SWP_DEFERERASE;

/** Windows-only position writer that never enters Chromium's resize path. */
export function createNativeWindowPosition(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return unavailable('not-windows');
  try {
    const bindings = options.bindings ?? createBindings(options.koffi ?? koffi);
    return {
      available: true,
      backend: 'koffi-set-window-pos',
      move(windowHandle, point) {
        if (!windowHandle || !Number.isInteger(point?.x) || !Number.isInteger(point?.y)) {
          throw new TypeError('Native window positioning requires an HWND and integer screen point');
        }
        const moved = Boolean(bindings.setWindowPos(
          BigInt(windowHandle), 0n, point.x, point.y, 0, 0, POSITION_ONLY_FLAGS,
        ));
        return { moved, error: moved ? 0 : Number(bindings.getLastError()), flags: POSITION_ONLY_FLAGS };
      },
    };
  }
  catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

function createBindings(api) {
  const user32 = api.load('user32.dll');
  const kernel32 = api.load('kernel32.dll');
  return {
    setWindowPos: user32.func('int __stdcall SetWindowPos(uintptr_t hWnd, uintptr_t hWndInsertAfter, int x, int y, int cx, int cy, uint32_t flags)'),
    getLastError: kernel32.func('uint32_t __stdcall GetLastError()'),
  };
}
function unavailable(reason) {
  return {
    available: false,
    backend: 'unavailable',
    reason,
    move: () => ({ moved: false, error: -1, flags: POSITION_ONLY_FLAGS }),
  };
}
