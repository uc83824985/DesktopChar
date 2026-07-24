import assert from 'node:assert/strict';
import test from 'node:test';
import {
  effectiveAvatarVisibility,
  nextAvatarVisibility,
  shouldRecoverAvatarVisibility,
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

test('effective visibility distinguishes user intent from an externally hidden window', () => {
  assert.equal(effectiveAvatarVisibility({
    intentVisible: true,
    windowVisible: true,
    presentationPhase: 'visible',
  }), true);
  assert.equal(effectiveAvatarVisibility({
    intentVisible: true,
    windowVisible: false,
    presentationPhase: 'visible',
  }), false);
  assert.equal(effectiveAvatarVisibility({
    intentVisible: true,
    windowVisible: true,
    presentationPhase: 'warming',
  }), true);
  assert.equal(effectiveAvatarVisibility({
    intentVisible: false,
    windowVisible: true,
    presentationPhase: 'visible',
  }), false);
});

test('only an unintended visible-state loss requests recovery', () => {
  assert.equal(shouldRecoverAvatarVisibility({
    intentVisible: true,
    windowVisible: false,
    minimized: false,
    presentationPhase: 'visible',
  }), true);
  assert.equal(shouldRecoverAvatarVisibility({
    intentVisible: true,
    windowVisible: true,
    minimized: true,
    presentationPhase: 'visible',
  }), true);
  assert.equal(shouldRecoverAvatarVisibility({
    intentVisible: false,
    windowVisible: false,
    minimized: false,
    presentationPhase: 'hidden',
  }), false);
  assert.equal(shouldRecoverAvatarVisibility({
    intentVisible: true,
    windowVisible: false,
    minimized: false,
    presentationPhase: 'warming',
  }), false);
});
