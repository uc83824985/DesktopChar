export function refreshChromiumCursorAtScreenPoint(window, screenPoint) {
  if (!window || window.isDestroyed() || !isPoint(screenPoint)) return false;
  const bounds = window.getBounds();
  const x = screenPoint.x - bounds.x;
  const y = screenPoint.y - bounds.y;
  if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return false;
  window.webContents.sendInputEvent({
    type: 'mouseMove',
    x,
    y,
    globalX: screenPoint.x,
    globalY: screenPoint.y,
    movementX: 0,
    movementY: 0,
  });
  return true;
}

function isPoint(value) {
  return value && Number.isFinite(value.x) && Number.isFinite(value.y);
}
