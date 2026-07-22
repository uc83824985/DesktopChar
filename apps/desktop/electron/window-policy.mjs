export const DEFAULT_AVATAR_WINDOW_SIZE = Object.freeze({ width: 460, height: 700 });
export const DEFAULT_AVATAR_WINDOW_MARGIN = 24;
export const DEFAULT_DRAG_HOLD_DELAY_MS = 180;

export function initialAvatarBounds(workArea, size = DEFAULT_AVATAR_WINDOW_SIZE, margin = DEFAULT_AVATAR_WINDOW_MARGIN) {
  const fitted = fitSizeToWorkArea(size, workArea, margin);
  return {
    x: Math.round(workArea.x + workArea.width - fitted.width - margin),
    y: Math.round(workArea.y + workArea.height - fitted.height - margin),
    width: fitted.width,
    height: fitted.height,
  };
}

export function dragAvatarBounds(startBounds, startPointer, currentPointer, workArea) {
  assertPoint(startPointer, 'startPointer');
  assertPoint(currentPointer, 'currentPointer');
  return clampBoundsToWorkArea({
    ...startBounds,
    x: Math.round(startBounds.x + currentPointer.x - startPointer.x),
    y: Math.round(startBounds.y + currentPointer.y - startPointer.y),
  }, workArea);
}

/** Moves a fixed-size transparent window through its stable bounds path. */
export function applyDragAvatarBounds(target, bounds) {
  assertRectangle(bounds, 'bounds');
  if (!target || typeof target.getBounds !== 'function' || typeof target.setBounds !== 'function') {
    throw new TypeError('Drag target must expose getBounds and setBounds');
  }
  const current = target.getBounds();
  if (current.x === bounds.x && current.y === bounds.y) return false;
  target.setBounds(bounds, false);
  return true;
}

export function clampBoundsToWorkArea(bounds, workArea) {
  assertRectangle(bounds, 'bounds');
  assertRectangle(workArea, 'workArea');
  const width = Math.min(Math.round(bounds.width), Math.round(workArea.width));
  const height = Math.min(Math.round(bounds.height), Math.round(workArea.height));
  return {
    x: Math.round(Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width))),
    y: Math.round(Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height))),
    width,
    height,
  };
}

export function isScreenPoint(value) {
  return value !== null
    && typeof value === 'object'
    && Number.isFinite(value.x)
    && Number.isFinite(value.y);
}

export function parseLoopbackDevUrl(value) {
  if (value === undefined || value === '') return undefined;
  const url = new URL(value);
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (url.protocol !== 'http:' || !loopbackHosts.has(url.hostname)) {
    throw new TypeError('DESKTOP_CHAR_DEV_URL must be an HTTP loopback URL');
  }
  return url.toString();
}

export function parseDragHoldDelayMs(value) {
  if (value === undefined || value === '') return DEFAULT_DRAG_HOLD_DELAY_MS;
  const delayMs = Number(value);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs >= 1_000) {
    throw new TypeError('DESKTOP_CHAR_DRAG_HOLD_DELAY_MS must be an integer between 0 and 999');
  }
  return delayMs;
}

/** Separates a cursor-only update from a native mouse-passthrough mutation. */
export function describePointerPresentationChange(previous, next, previouslyApplied, options = {}) {
  const passthroughChanged = !previouslyApplied || previous.passthrough !== next.passthrough;
  const cursorChanged = previous.cursor !== next.cursor;
  return {
    passthroughChanged,
    cursorChanged,
    enteredInteractive: previouslyApplied && previous.passthrough && !next.passthrough,
    refreshCursor: Boolean(options.forceCursorRefresh)
      || previouslyApplied && (passthroughChanged || cursorChanged),
  };
}

function fitSizeToWorkArea(size, workArea, margin) {
  assertRectangle({ x: 0, y: 0, ...size }, 'size');
  assertRectangle(workArea, 'workArea');
  const safeMargin = Number.isFinite(margin) && margin >= 0 ? margin : 0;
  return {
    width: Math.max(1, Math.min(Math.round(size.width), Math.round(workArea.width - safeMargin * 2))),
    height: Math.max(1, Math.min(Math.round(size.height), Math.round(workArea.height - safeMargin * 2))),
  };
}

function assertPoint(value, name) {
  if (!isScreenPoint(value)) throw new TypeError(`${name} must contain finite x and y`);
}

function assertRectangle(value, name) {
  if (!isScreenPoint(value) || !Number.isFinite(value.width) || !Number.isFinite(value.height) || value.width <= 0 || value.height <= 0) {
    throw new TypeError(`${name} must be a positive finite rectangle`);
  }
}
