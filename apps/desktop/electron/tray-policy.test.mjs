import assert from 'node:assert/strict';
import test from 'node:test';
import { nextAvatarVisibility, trayVisibilityLabel } from './tray-policy.mjs';

test('tray visibility action and label always describe the next transition', () => {
  assert.equal(trayVisibilityLabel(true), '隐藏角色');
  assert.equal(nextAvatarVisibility(true), false);
  assert.equal(trayVisibilityLabel(false), '显示角色');
  assert.equal(nextAvatarVisibility(false), true);
});
