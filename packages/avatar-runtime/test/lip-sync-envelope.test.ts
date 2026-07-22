import assert from 'node:assert/strict';
import test from 'node:test';
import { LipSyncEnvelope, validateLipSyncProfile } from '../src/lip-sync-envelope.ts';

const profile = {
  gain: 1,
  attackMs: 30,
  releaseMs: 100,
  peakHoldMs: 25,
};

test('level envelope opens quickly, holds short peaks, and closes progressively', () => {
  const envelope = new LipSyncEnvelope(profile);
  envelope.reset(0);

  const opening = envelope.update(1, 25);
  const held = envelope.update(0, 50);
  const firstRelease = envelope.update(0, 75);
  const laterRelease = envelope.update(0, 150);

  assert.ok(opening > 0.8 && opening < 1);
  assert.ok(held > opening, 'the one-sample drop should be covered by peak hold');
  assert.ok(firstRelease > 0 && firstRelease < held);
  assert.ok(laterRelease > 0 && laterRelease < firstRelease);
});

test('level envelope uses playback position rather than event arrival intervals', () => {
  const regular = new LipSyncEnvelope(profile);
  regular.reset(0);
  regular.update(0.6, 25);
  const regularValue = regular.update(0.6, 50);

  const delayed = new LipSyncEnvelope(profile);
  delayed.reset(0);
  const delayedValue = delayed.update(0.6, 50);

  assert.ok(Math.abs(regularValue - delayedValue) < 1e-12);
});

test('zero response times preserve the legacy direct level mapping', () => {
  const envelope = new LipSyncEnvelope({ gain: 2.5, attackMs: 0, releaseMs: 0, peakHoldMs: 0 });
  envelope.reset(0);
  assert.equal(envelope.update(0.224, 25), 0.56);
  assert.equal(envelope.update(0.8, 50), 1);
  assert.equal(envelope.update(0, 75), 0);
});

test('lip-sync profile rejects invalid temporal values', () => {
  assert.throws(
    () => validateLipSyncProfile({ ...profile, releaseMs: -1 }),
    /releaseMs must be non-negative and finite/,
  );
});
