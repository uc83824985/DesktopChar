import koffi from 'koffi';

const GWL_EXSTYLE = -20;
const WS_EX_TOPMOST = 0x00000008n;
const HWND_TOPMOST = -1n;
const HWND_NOTOPMOST = -2n;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOOWNERZORDER = 0x0200;
const SWP_NOSENDCHANGING = 0x0400;
const TOPMOST_ONLY_FLAGS = SWP_NOSIZE
  | SWP_NOMOVE
  | SWP_NOACTIVATE
  | SWP_NOOWNERZORDER
  | SWP_NOSENDCHANGING;

/**
 * Reads and repairs the native WS_EX_TOPMOST state instead of trusting
 * Electron's cached always-on-top intent.
 */
export function createNativeWindowTopmost(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return unavailable('not-windows');
  try {
    const bindings = options.bindings ?? createBindings(options.koffi ?? koffi);
    const inspect = windowHandle => inspectWindow(bindings, windowHandle);
    return {
      available: true,
      backend: 'koffi-window-topmost',
      inspect,
      foreground() {
        const handle = BigInt(bindings.getForegroundWindow());
        if (!handle) return {
          handle: 0n,
          valid: false,
          topmost: null,
          exStyle: null,
          error: 0,
        };
        return { handle, ...inspect(handle) };
      },
      set(windowHandle, topmost, setOptions = {}) {
        const before = inspect(windowHandle);
        if (!before.valid) return {
          changed: false,
          topmost: null,
          error: before.error,
          flags: TOPMOST_ONLY_FLAGS,
        };
        if (before.topmost === topmost) return {
          changed: false,
          topmost,
          error: 0,
          flags: TOPMOST_ONLY_FLAGS,
        };
        const insertAfter = topmost && setOptions.insertAfter
          ? normalizeWindowHandle(setOptions.insertAfter)
          : topmost ? HWND_TOPMOST : HWND_NOTOPMOST;
        const accepted = Boolean(bindings.setWindowPos(
          normalizeWindowHandle(windowHandle),
          insertAfter,
          0,
          0,
          0,
          0,
          TOPMOST_ONLY_FLAGS,
        ));
        const after = inspect(windowHandle);
        return {
          changed: accepted && after.topmost === topmost,
          topmost: after.topmost,
          error: accepted ? 0 : Number(bindings.getLastError()),
          flags: TOPMOST_ONLY_FLAGS,
        };
      },
    };
  }
  catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

function inspectWindow(bindings, windowHandle) {
  const handle = normalizeWindowHandle(windowHandle);
  if (!bindings.isWindow(handle)) return {
    valid: false,
    topmost: null,
    exStyle: null,
    error: 1400,
  };
  const exStyle = BigInt.asUintN(64, BigInt(bindings.getWindowLongPtr(handle, GWL_EXSTYLE)));
  return {
    valid: true,
    topmost: Boolean(exStyle & WS_EX_TOPMOST),
    exStyle: `0x${exStyle.toString(16).toUpperCase()}`,
    error: 0,
  };
}

function normalizeWindowHandle(windowHandle) {
  if (typeof windowHandle !== 'bigint' && !Number.isSafeInteger(windowHandle)) {
    throw new TypeError('Native topmost control requires a valid HWND');
  }
  const handle = BigInt(windowHandle);
  if (handle <= 0n) throw new TypeError('Native topmost control requires a valid HWND');
  return handle;
}

function createBindings(api) {
  const user32 = api.load('user32.dll');
  const kernel32 = api.load('kernel32.dll');
  return {
    isWindow: user32.func('int __stdcall IsWindow(uintptr_t hWnd)'),
    getForegroundWindow: user32.func('uintptr_t __stdcall GetForegroundWindow()'),
    getWindowLongPtr: user32.func('intptr_t __stdcall GetWindowLongPtrW(uintptr_t hWnd, int index)'),
    setWindowPos: user32.func('int __stdcall SetWindowPos(uintptr_t hWnd, intptr_t hWndInsertAfter, int x, int y, int cx, int cy, uint32_t flags)'),
    getLastError: kernel32.func('uint32_t __stdcall GetLastError()'),
  };
}

function unavailable(reason) {
  return {
    available: false,
    backend: 'unavailable',
    reason,
    inspect: () => ({ valid: false, topmost: null, exStyle: null, error: -1 }),
    foreground: () => ({
      handle: 0n,
      valid: false,
      topmost: null,
      exStyle: null,
      error: -1,
    }),
    set: () => ({
      changed: false,
      topmost: null,
      error: -1,
      flags: TOPMOST_ONLY_FLAGS,
    }),
  };
}
