import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialSnapshot, reduceAvatarSnapshot } from '../src/reducer.ts';
import { capabilities, plan } from './helpers.ts';

test('only playback.started moves the runtime into speaking', () => {
  let transition = reduceAvatarSnapshot(createInitialSnapshot(), { type: 'plan.submitted', plan });
  assert.equal(transition.snapshot.state, 'thinking');

  transition = reduceAvatarSnapshot(transition.snapshot, {
    type: 'tts.segment-ready',
    generation: 0,
    segmentId: 'segment-1',
    sequence: 0,
    audio: {
      delivery: 'artifact', requestId: 'segment-1',
      uri: 'memory://segment-1', mimeType: 'audio/wav',
    },
  });
  assert.equal(transition.snapshot.state, 'thinking');

  transition = reduceAvatarSnapshot(transition.snapshot, {
    type: 'playback.buffering',
    generation: 0,
    segmentId: 'segment-1',
    positionMs: 0,
    bufferedMs: 120,
  });
  assert.equal(transition.snapshot.state, 'thinking');
  assert.equal(transition.snapshot.playback.status, 'buffering');

  transition = reduceAvatarSnapshot(transition.snapshot, {
    type: 'playback.started',
    generation: 0,
    segmentId: 'segment-1',
    positionMs: 0,
  });
  assert.equal(transition.snapshot.state, 'speaking');
});

test('stream stalls and recovery only update playback state', () => {
  let snapshot = reduceAvatarSnapshot(createInitialSnapshot(), { type: 'plan.submitted', plan }).snapshot;
  snapshot = reduceAvatarSnapshot(snapshot, {
    type: 'playback.started', generation: 0, segmentId: 'segment-1', positionMs: 20,
  }).snapshot;

  snapshot = reduceAvatarSnapshot(snapshot, {
    type: 'playback.stalled', generation: 0, segmentId: 'segment-1', positionMs: 80,
  }).snapshot;
  assert.equal(snapshot.state, 'speaking');
  assert.deepEqual(snapshot.playback, { status: 'buffering', positionMs: 80 });

  snapshot = reduceAvatarSnapshot(snapshot, {
    type: 'playback.recovered', generation: 0, segmentId: 'segment-1', positionMs: 80,
  }).snapshot;
  assert.equal(snapshot.state, 'speaking');
  assert.deepEqual(snapshot.playback, { status: 'playing', positionMs: 80 });
});

test('interrupt is idempotent and stale generation events are ignored', () => {
  let snapshot = reduceAvatarSnapshot(createInitialSnapshot(), { type: 'plan.submitted', plan }).snapshot;
  const first = reduceAvatarSnapshot(snapshot, { type: 'user.interrupt-requested' });
  assert.equal(first.snapshot.state, 'idle');
  assert.equal(first.snapshot.generation, 1);
  assert.deepEqual(
    first.effects.map(effect => effect.type),
    ['tts.cancel', 'performance.cancel', 'performance.cancel-v2', 'audio.stop'],
  );

  const stale = reduceAvatarSnapshot(first.snapshot, {
    type: 'playback.started',
    generation: 0,
    segmentId: 'segment-1',
    positionMs: 0,
  });
  assert.strictEqual(stale.snapshot, first.snapshot);

  const second = reduceAvatarSnapshot(first.snapshot, { type: 'user.interrupt-requested' });
  assert.equal(second.snapshot.state, 'idle');
  assert.equal(second.snapshot.generation, 2);
});

test('gaze input is capability-aware and clamped', () => {
  let snapshot = reduceAvatarSnapshot(createInitialSnapshot(), {
    type: 'user.look-target-changed', x: 2, y: -2,
  }).snapshot;
  assert.equal(snapshot.gaze.active, false);

  snapshot = reduceAvatarSnapshot(snapshot, { type: 'renderer.ready', capabilities }).snapshot;
  snapshot = reduceAvatarSnapshot(snapshot, {
    type: 'user.look-target-changed', x: 2, y: -2,
  }).snapshot;
  assert.deepEqual(snapshot.gaze, { x: 1, y: -1, active: true });
});

test('gaze follow is persistent until explicitly disabled', () => {
  let snapshot = reduceAvatarSnapshot(createInitialSnapshot(), {
    type: 'renderer.ready', capabilities,
  }).snapshot;
  snapshot = reduceAvatarSnapshot(snapshot, {
    type: 'user.look-target-changed', x: 0.5, y: -0.25,
  }).snapshot;
  snapshot = reduceAvatarSnapshot(snapshot, { type: 'user.interrupt-requested' }).snapshot;
  assert.deepEqual(snapshot.gaze, { x: 0.5, y: -0.25, active: true });

  snapshot = reduceAvatarSnapshot(snapshot, { type: 'user.gaze-follow-disabled' }).snapshot;
  snapshot = reduceAvatarSnapshot(snapshot, {
    type: 'user.look-target-changed', x: -0.75, y: 0.25,
  }).snapshot;
  assert.deepEqual(snapshot.gaze, { x: -0.75, y: 0.25, active: false });

  snapshot = reduceAvatarSnapshot(snapshot, { type: 'user.gaze-follow-enabled' }).snapshot;
  assert.equal(snapshot.gaze.active, true);
});
