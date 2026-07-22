import {
  DEFAULT_LIP_SYNC_PROFILE,
  type LipSyncProfile,
} from '../../contracts/src/index.ts';

const NINETY_PERCENT_RESPONSE = Math.log(10);
const SETTLED_EPSILON = 0.001;

/**
 * Runtime-owned level envelope for amplitude lip sync.
 *
 * Audio players report raw, clock-aligned level facts. This follower turns those
 * facts into a visually stable mouth value without changing the audio timeline.
 * Attack and release are asymmetric because a prompt opening reads as speech,
 * while an equally prompt close looks like a binary switch.
 */
export class LipSyncEnvelope {
  private readonly profile: LipSyncProfile;
  private currentValue = 0;
  private heldPeak = 0;
  private holdUntilMs = Number.NEGATIVE_INFINITY;
  private lastPositionMs = 0;

  constructor(profile: LipSyncProfile = { ...DEFAULT_LIP_SYNC_PROFILE }) {
    validateLipSyncProfile(profile);
    this.profile = profile;
  }

  current(): number {
    return this.currentValue;
  }

  reset(positionMs = 0): number {
    if (!Number.isFinite(positionMs) || positionMs < 0) {
      throw new RangeError('lip-sync positionMs must be non-negative and finite');
    }
    this.currentValue = 0;
    this.heldPeak = 0;
    this.holdUntilMs = Number.NEGATIVE_INFINITY;
    this.lastPositionMs = positionMs;
    return this.currentValue;
  }

  update(rawLevel: number, positionMs: number): number {
    if (!Number.isFinite(rawLevel)) throw new RangeError('lip-sync level must be finite');
    if (!Number.isFinite(positionMs) || positionMs < 0) {
      throw new RangeError('lip-sync positionMs must be non-negative and finite');
    }
    if (positionMs < this.lastPositionMs) this.reset(positionMs);

    const elapsedMs = positionMs - this.lastPositionMs;
    const input = clamp01(Math.max(0, rawLevel) * this.profile.gain);
    if (input >= this.heldPeak) {
      this.heldPeak = input;
      this.holdUntilMs = positionMs + this.profile.peakHoldMs;
    }
    else if (positionMs > this.holdUntilMs) {
      this.heldPeak = input;
    }

    const target = positionMs <= this.holdUntilMs ? Math.max(input, this.heldPeak) : input;
    const responseMs = target >= this.currentValue ? this.profile.attackMs : this.profile.releaseMs;
    const alpha = responseMs === 0
      ? 1
      : 1 - Math.exp(-NINETY_PERCENT_RESPONSE * elapsedMs / responseMs);
    this.currentValue += (target - this.currentValue) * alpha;
    if (Math.abs(target - this.currentValue) <= SETTLED_EPSILON) this.currentValue = target;
    this.lastPositionMs = positionMs;
    return this.currentValue;
  }
}

export function validateLipSyncProfile(profile: LipSyncProfile): void {
  positive(profile.gain, 'lipSyncProfile.gain');
  nonNegative(profile.attackMs, 'lipSyncProfile.attackMs');
  nonNegative(profile.releaseMs, 'lipSyncProfile.releaseMs');
  nonNegative(profile.peakHoldMs, 'lipSyncProfile.peakHoldMs');
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function positive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive and finite`);
}

function nonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be non-negative and finite`);
}
