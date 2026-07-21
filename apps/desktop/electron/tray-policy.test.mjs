import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextAvatarVisibility,
  trayIconRepresentations,
  trayVisibilityLabel,
} from './tray-policy.mjs';

test('tray icon representations cover standard Windows DPI scales without upscaling 16px', () => {
  assert.deepEqual(trayIconRepresentations(), [
    { scaleFactor: 1, pixelSize: 16 },
    { scaleFactor: 1.25, pixelSize: 20 },
    { scaleFactor: 1.5, pixelSize: 24 },
    { scaleFactor: 1.75, pixelSize: 28 },
    { scaleFactor: 2, pixelSize: 32 },
    { scaleFactor: 2.5, pixelSize: 40 },
    { scaleFactor: 3, pixelSize: 48 },
  ]);
});

test('tray icon representation policy rejects invalid logical sizes and scales', () => {
  assert.throws(() => trayIconRepresentations(0), /positive integer/);
  assert.throws(() => trayIconRepresentations(16, [1, 0]), /positive numbers/);
});

test('tray visibility action and label always describe the next transition', () => {
  assert.equal(trayVisibilityLabel(true), '隐藏角色');
  assert.equal(nextAvatarVisibility(true), false);
  assert.equal(trayVisibilityLabel(false), '显示角色');
  assert.equal(nextAvatarVisibility(false), true);
});
