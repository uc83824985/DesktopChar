export function trayVisibilityLabel(avatarVisible) {
  return avatarVisible ? '隐藏角色' : '显示角色';
}

export function nextAvatarVisibility(avatarVisible) {
  return !avatarVisible;
}
