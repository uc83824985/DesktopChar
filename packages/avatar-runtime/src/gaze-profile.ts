import type { GazeAxisProfile, GazeProfile, ParameterFrame } from '../../contracts/src/index.ts';

export const DEFAULT_GAZE_PROFILE: GazeProfile = {
  headX: axisProfile(-30, 30),
  headY: axisProfile(-30, 30),
  eyeX: axisProfile(-1, 1),
  eyeY: axisProfile(-1, 1),
};

export function mapGazeTarget(x: number, y: number, profile: GazeProfile): ParameterFrame {
  validateGazeProfile(profile);
  return {
    ParamAngleX: projectAxis(x, profile.headX),
    ParamAngleY: projectAxis(y, profile.headY),
    ParamEyeBallX: projectAxis(x, profile.eyeX),
    ParamEyeBallY: projectAxis(y, profile.eyeY),
  };
}

export function validateGazeProfile(profile: GazeProfile): void {
  for (const [name, axis] of Object.entries(profile) as Array<[keyof GazeProfile, GazeAxisProfile]>) {
    if (!Number.isFinite(axis.negative.limit) || axis.negative.limit > 0) {
      throw new RangeError(`${name}.negative.limit must be finite and non-positive`);
    }
    if (!Number.isFinite(axis.positive.limit) || axis.positive.limit < 0) {
      throw new RangeError(`${name}.positive.limit must be finite and non-negative`);
    }
    for (const [direction, curve] of Object.entries({ negative: axis.negative, positive: axis.positive })) {
      if (!Number.isFinite(curve.exponent) || curve.exponent <= 0) {
        throw new RangeError(`${name}.${direction}.exponent must be positive and finite`);
      }
    }
    if (!Number.isFinite(axis.deadZone) || axis.deadZone < 0 || axis.deadZone >= 1) {
      throw new RangeError(`${name}.deadZone must be in [0, 1)`);
    }
  }
}

function projectAxis(value: number, profile: GazeAxisProfile): number {
  const normalized = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
  const magnitude = Math.max(0, (Math.abs(normalized) - profile.deadZone) / (1 - profile.deadZone));
  const direction = normalized < 0 ? profile.negative : profile.positive;
  return magnitude ** direction.exponent * direction.limit;
}

function axisProfile(negativeLimit: number, positiveLimit: number, exponent = 1, deadZone = 0): GazeAxisProfile {
  return {
    negative: { limit: negativeLimit, exponent },
    positive: { limit: positiveLimit, exponent },
    deadZone,
  };
}
