import type {
  GazeProfile,
  ParameterFrame,
} from '../../contracts/src/index.ts';
import { mapGazeTarget, validateGazeProfile } from './gaze-profile.ts';

const SETTLE_EPSILON = 0.0001;
const GAZE_PARAMETERS = [
  'ParamAngleX',
  'ParamAngleY',
  'ParamEyeBallX',
  'ParamEyeBallY',
] as const;

/**
 * Runtime-owned presentation state for gaze. Pointer events only replace the
 * reference target; rendered values advance independently from input cadence.
 */
export class GazeInterpolator {
  private readonly profile: GazeProfile;
  private reference: ParameterFrame;
  private target: ParameterFrame;
  private current: ParameterFrame;
  private active = false;
  private dirty = false;

  constructor(profile: GazeProfile) {
    validateGazeProfile(profile);
    this.profile = profile;
    this.reference = mapGazeTarget(0, 0, profile);
    this.target = neutralFrame();
    this.current = neutralFrame();
  }

  setReference(x: number, y: number): void {
    const next = mapGazeTarget(x, y, this.profile);
    if (framesEqual(next, this.reference)) return;
    this.reference = next;
    if (this.active) this.setTarget(next);
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.setTarget(active ? this.reference : neutralFrame());
    // Even a centered transition must submit one frame so the gaze layer keeps
    // explicit ownership over the parameters.
    this.dirty = true;
  }

  advance(deltaMs: number): ParameterFrame | null {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new RangeError('Gaze frame deltaMs must be finite and non-negative');
    }

    let changed = this.dirty;
    for (const parameter of GAZE_PARAMETERS) {
      const responseMs = parameter.startsWith('ParamEye')
        ? this.profile.smoothing.eyeResponseMs
        : this.profile.smoothing.headResponseMs;
      const next = approach(this.current[parameter]!, this.target[parameter]!, deltaMs, responseMs);
      if (next !== this.current[parameter]) {
        this.current[parameter] = next;
        changed = true;
      }
    }
    this.dirty = false;
    return changed ? { ...this.current } : null;
  }

  private setTarget(target: ParameterFrame): void {
    if (framesEqual(target, this.target)) return;
    this.target = { ...target };
    this.dirty = true;
  }
}

function approach(current: number, target: number, deltaMs: number, responseMs: number): number {
  if (responseMs === 0) return target;
  const alpha = 1 - Math.pow(0.1, deltaMs / responseMs);
  const next = current + (target - current) * alpha;
  return Math.abs(target - next) <= SETTLE_EPSILON ? target : next;
}

function framesEqual(left: ParameterFrame, right: ParameterFrame): boolean {
  return GAZE_PARAMETERS.every(parameter => left[parameter] === right[parameter]);
}

function neutralFrame(): ParameterFrame {
  return Object.fromEntries(GAZE_PARAMETERS.map(parameter => [parameter, 0]));
}
