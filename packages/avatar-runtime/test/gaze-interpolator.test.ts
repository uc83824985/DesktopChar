import assert from 'node:assert/strict';
import test from 'node:test';
import type { GazeProfile } from '../../contracts/src/index.ts';
import { DEFAULT_GAZE_PROFILE, GazeInterpolator } from '../src/index.ts';

test('gaze interpolation is invariant to render frame partitioning', () => {
  const oneFrame = activeInterpolator(profile(100, 50), 1, -0.5);
  const manyFrames = activeInterpolator(profile(100, 50), 1, -0.5);

  const oneResult = oneFrame.advance(100)!;
  let manyResult = manyFrames.advance(0)!;
  for (let frame = 0; frame < 10; frame++) manyResult = manyFrames.advance(10)!;

  approx(manyResult.ParamAngleX!, oneResult.ParamAngleX!);
  approx(manyResult.ParamAngleY!, oneResult.ParamAngleY!);
  approx(manyResult.ParamEyeBallX!, oneResult.ParamEyeBallX!);
  approx(manyResult.ParamEyeBallY!, oneResult.ParamEyeBallY!);
});

test('repeated reference samples do not restart or define the interpolation', () => {
  const singleSample = activeInterpolator(profile(100, 50), 0.75, 0.25);
  const repeatedSample = activeInterpolator(profile(100, 50), 0.75, 0.25);
  let singleFrame = singleSample.advance(0)!;
  let repeatedFrame = repeatedSample.advance(0)!;

  for (let frame = 0; frame < 6; frame++) {
    singleFrame = singleSample.advance(16)!;
    repeatedSample.setReference(0.75, 0.25);
    repeatedFrame = repeatedSample.advance(16)!;
  }

  assert.deepEqual(repeatedFrame, singleFrame);
});

test('eyes acquire a reference before the slower head and disabling returns to neutral', () => {
  const interpolator = activeInterpolator(profile(100, 50), 1, 1);
  const acquisition = interpolator.advance(50)!;
  approx(acquisition.ParamEyeBallX!, 0.9);
  approx(acquisition.ParamAngleX!, 30 * (1 - Math.sqrt(0.1)));
  assert.ok(acquisition.ParamEyeBallX! / 1 > acquisition.ParamAngleX! / 30);

  interpolator.setActive(false);
  const returning = interpolator.advance(50)!;
  assert.ok(returning.ParamEyeBallX! < acquisition.ParamEyeBallX!);
  assert.ok(returning.ParamAngleX! < acquisition.ParamAngleX!);
  assert.deepEqual(interpolator.advance(1_000), {
    ParamAngleX: 0,
    ParamAngleY: 0,
    ParamEyeBallX: 0,
    ParamEyeBallY: 0,
  });
  assert.equal(interpolator.advance(16), null);
});

test('gaze interpolation rejects invalid frame time', () => {
  const interpolator = new GazeInterpolator(DEFAULT_GAZE_PROFILE);
  assert.throws(() => interpolator.advance(-1), /deltaMs/);
  assert.throws(() => interpolator.advance(Number.NaN), /deltaMs/);
});

function activeInterpolator(profile: GazeProfile, x: number, y: number): GazeInterpolator {
  const interpolator = new GazeInterpolator(profile);
  interpolator.setActive(true);
  interpolator.setReference(x, y);
  return interpolator;
}

function profile(headResponseMs: number, eyeResponseMs: number): GazeProfile {
  return {
    ...DEFAULT_GAZE_PROFILE,
    smoothing: { headResponseMs, eyeResponseMs },
  };
}

function approx(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}
