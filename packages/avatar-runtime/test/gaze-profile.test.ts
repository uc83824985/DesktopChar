import assert from 'node:assert/strict';
import test from 'node:test';
import type { GazeProfile } from '../../contracts/src/index.ts';
import { DEFAULT_GAZE_PROFILE, mapGazeTarget, validateGazeProfile } from '../src/index.ts';

test('default gaze profile maps normalized targets symmetrically', () => {
  assert.deepEqual(mapGazeTarget(-1, 1, DEFAULT_GAZE_PROFILE), {
    ParamAngleX: -30, ParamAngleY: 30, ParamEyeBallX: -1, ParamEyeBallY: 1,
  });
});

test('character gaze profile can compensate asymmetric authored deformation', () => {
  const profile: GazeProfile = {
    ...DEFAULT_GAZE_PROFILE,
    headY: {
      negative: { limit: -20, exponent: 1 },
      positive: { limit: 30, exponent: 0.5 },
      deadZone: 0,
    },
  };
  assert.equal(mapGazeTarget(0, -1, profile).ParamAngleY, -20);
  assert.equal(mapGazeTarget(0, 1, profile).ParamAngleY, 30);
  assert.equal(mapGazeTarget(0, 0.25, profile).ParamAngleY, 15);
});

test('gaze profiles reject invalid directional limits and curves', () => {
  assert.throws(() => validateGazeProfile({
    ...DEFAULT_GAZE_PROFILE,
    headY: { ...DEFAULT_GAZE_PROFILE.headY, negative: { limit: 1, exponent: 1 } },
  }), /negative\.limit/);
  assert.throws(() => validateGazeProfile({
    ...DEFAULT_GAZE_PROFILE,
    eyeY: { ...DEFAULT_GAZE_PROFILE.eyeY, positive: { limit: 1, exponent: 0 } },
  }), /positive\.exponent/);
});
