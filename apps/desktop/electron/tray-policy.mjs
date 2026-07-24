export const TRAY_ICON_LOGICAL_SIZE = 16;
export const TRAY_ICON_SCALE_FACTORS = Object.freeze([1, 1.25, 1.5, 1.75, 2, 2.5, 3]);

export function trayIconRepresentations(
  logicalSize = TRAY_ICON_LOGICAL_SIZE,
  scaleFactors = TRAY_ICON_SCALE_FACTORS,
) {
  if (!Number.isInteger(logicalSize) || logicalSize <= 0) {
    throw new TypeError('Tray icon logical size must be a positive integer');
  }
  return scaleFactors.map(scaleFactor => {
    if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
      throw new TypeError('Tray icon scale factors must be positive numbers');
    }
    return { scaleFactor, pixelSize: Math.round(logicalSize * scaleFactor) };
  });
}

export function trayVisibilityLabel(avatarVisible) {
  return avatarVisible ? '隐藏角色' : '显示角色';
}

export function nextAvatarVisibility(avatarVisible) {
  return !avatarVisible;
}

export function effectiveAvatarVisibility({
  intentVisible,
  windowVisible,
  presentationPhase,
}) {
  if (!intentVisible) return false;
  if (presentationPhase === 'warming') return true;
  return presentationPhase === 'visible' && windowVisible;
}

export function shouldRecoverAvatarVisibility({
  intentVisible,
  windowVisible,
  minimized,
  presentationPhase,
}) {
  return intentVisible
    && presentationPhase === 'visible'
    && (!windowVisible || minimized);
}
