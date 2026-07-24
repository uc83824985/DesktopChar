export const WM_WINDOWPOSCHANGED = 0x0047;
export const WM_STYLECHANGED = 0x007d;

const WINDOW_MESSAGES = Object.freeze([
  { id: WM_WINDOWPOSCHANGED, reason: 'wm-windowposchanged' },
  { id: WM_STYLECHANGED, reason: 'wm-stylechanged' },
]);

/**
 * Uses native window messages as the steady-state signal. A short retry timer
 * exists only while reconciliation explicitly defers or a native repair
 * temporarily fails.
 */
export function createTopmostEventMonitor(options) {
  const {
    window,
    reconcile,
    eventDebounceMs = 32,
    incidentRetryMs = 250,
    scheduler = globalThis,
    onError = () => {},
  } = options ?? {};
  if (!window
    || typeof window.hookWindowMessage !== 'function'
    || typeof window.unhookWindowMessage !== 'function'
    || typeof reconcile !== 'function') {
    throw new TypeError('Topmost event monitor requires a native window and reconcile callback');
  }
  if (!Number.isFinite(eventDebounceMs) || eventDebounceMs < 0
    || !Number.isFinite(incidentRetryMs) || incidentRetryMs <= 0) {
    throw new TypeError('Topmost event monitor delays must be finite and non-negative');
  }

  let disposed = false;
  let eventTimer;
  let incidentTimer;
  let nativeMessageCount = 0;
  let reconcileCount = 0;
  let lastReason = null;
  let lastOutcome = null;
  const pendingReasons = new Set();
  const messageCallbacks = new Map();

  const scheduleEventCheck = reason => {
    if (disposed) return;
    pendingReasons.add(reason);
    if (eventTimer !== undefined) scheduler.clearTimeout(eventTimer);
    eventTimer = scheduler.setTimeout(() => {
      eventTimer = undefined;
      const combinedReason = [...pendingReasons].join('+');
      pendingReasons.clear();
      runReconcile(combinedReason || 'window-message');
    }, eventDebounceMs);
  };

  const runReconcile = reason => {
    if (disposed) return;
    let outcome;
    try {
      outcome = reconcile(reason, { deferForForegroundTopmost: true });
    }
    catch (error) {
      onError(error);
      outcome = 'failed';
    }
    reconcileCount += 1;
    lastReason = reason;
    lastOutcome = outcome;
    if (outcome === 'deferred' || outcome === 'failed') {
      if (incidentTimer === undefined) {
        incidentTimer = scheduler.setTimeout(() => {
          incidentTimer = undefined;
          runReconcile('topmost-incident-retry');
        }, incidentRetryMs);
      }
      return;
    }
    if (incidentTimer !== undefined) scheduler.clearTimeout(incidentTimer);
    incidentTimer = undefined;
  };

  for (const message of WINDOW_MESSAGES) {
    const callback = () => {
      nativeMessageCount += 1;
      scheduleEventCheck(message.reason);
    };
    messageCallbacks.set(message.id, callback);
    window.hookWindowMessage(message.id, callback);
  }
  const onAlwaysOnTopChanged = () => scheduleEventCheck('electron-always-on-top-changed');
  window.on?.('always-on-top-changed', onAlwaysOnTopChanged);

  return {
    request(reason = 'explicit-check') {
      scheduleEventCheck(reason);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (eventTimer !== undefined) scheduler.clearTimeout(eventTimer);
      if (incidentTimer !== undefined) scheduler.clearTimeout(incidentTimer);
      eventTimer = undefined;
      incidentTimer = undefined;
      pendingReasons.clear();
      for (const message of WINDOW_MESSAGES) window.unhookWindowMessage(message.id);
      window.off?.('always-on-top-changed', onAlwaysOnTopChanged);
    },
    snapshot() {
      return {
        disposed,
        eventCheckPending: eventTimer !== undefined,
        incidentRetryActive: incidentTimer !== undefined,
        pendingReasons: [...pendingReasons],
        nativeMessageCount,
        reconcileCount,
        lastReason,
        lastOutcome,
      };
    },
  };
}
