import assert from 'node:assert/strict';
import test from 'node:test';
import type { AvatarEvent, PerformancePlan, RuntimeEffect } from '../../contracts/src/index.ts';
import { ParameterMixer } from '../src/mixer.ts';
import { DefaultAvatarPlanner } from '../src/planner.ts';
import { AvatarRuntime } from '../src/runtime.ts';
import { ControlledEffects } from './fakes.ts';
import { capabilities } from './helpers.ts';

function createRuntime(effects: ControlledEffects): AvatarRuntime {
  const runtime = new AvatarRuntime({
    planner: new DefaultAvatarPlanner(),
    mixer: new ParameterMixer({
      ranges: {
        ParamMouthOpenY: { min: 0, max: 1 },
        ParamMouthForm: { min: -1, max: 1 },
      },
    }),
    effects,
  });
  runtime.dispatch({ type: 'renderer.ready', capabilities });
  return runtime;
}

function createRuntimeWithLipSyncGain(effects: ControlledEffects, gain: number): AvatarRuntime {
  const runtime = new AvatarRuntime({
    planner: new DefaultAvatarPlanner(),
    mixer: new ParameterMixer({ ranges: { ParamMouthOpenY: { min: 0, max: 1 } } }),
    effects,
    lipSyncProfile: { gain },
  });
  runtime.dispatch({ type: 'renderer.ready', capabilities });
  return runtime;
}

function threeSegmentPlan(): PerformancePlan {
  return {
    id: 'three',
    segments: [0, 1, 2].map(sequence => ({
      id: `segment-${sequence}`,
      sequence,
      displayText: `text-${sequence}`,
      speechText: `text-${sequence}`,
      ...(sequence === 0
        ? {
            emotion: { emotion: 'happy' as const, intensity: 0.6, atMs: 0 },
            actions: [{ id: 'nod-0', action: 'nod' as const, atMs: 200 }],
          }
        : {}),
    })),
  };
}

test('look events are projected through Runtime-owned renderer effects', () => {
  const effects = new ControlledEffects();
  const runtime = createRuntime(effects);
  runtime.dispatch({ type: 'user.look-target-changed', x: 0.5, y: -0.25 });
  assert.deepEqual(effects.frames.at(-1), {
    ParamAngleX: 15,
    ParamAngleY: -7.5,
    ParamEyeBallX: 0.5,
    ParamEyeBallY: -0.25,
    ParamMouthForm: 0,
    ParamMouthOpenY: 0,
  });
  assert.deepEqual(runtime.getSnapshot().gaze, { x: 0.5, y: -0.25, active: true });
});

test('gaze follow remains Runtime-owned across plans and interrupt until explicitly disabled', () => {
  const effects = new ControlledEffects();
  const runtime = createRuntime(effects);
  runtime.dispatch({ type: 'user.look-target-changed', x: -0.4, y: 0.6 });
  runtime.dispatch({ type: 'plan.submitted', plan: threeSegmentPlan() });
  assert.equal(runtime.getSnapshot().gaze.active, true);
  assert.equal(effects.frames.at(-1)?.ParamEyeBallX, -0.4);

  runtime.dispatch({ type: 'user.interrupt-requested' });
  assert.deepEqual(runtime.getSnapshot().gaze, { x: -0.4, y: 0.6, active: true });
  assert.equal(effects.frames.at(-1)?.ParamEyeBallY, 0.6);

  runtime.dispatch({ type: 'user.gaze-follow-disabled' });
  assert.equal(runtime.getSnapshot().gaze.active, false);
  assert.deepEqual(effects.frames.at(-1), {
    ParamAngleX: 0,
    ParamAngleY: 0,
    ParamEyeBallX: 0,
    ParamEyeBallY: 0,
    ParamMouthForm: 0,
    ParamMouthOpenY: 0,
  });
  const disabledFrameCount = effects.frames.length;
  runtime.dispatch({ type: 'user.look-target-changed', x: 0.8, y: -0.2 });
  assert.deepEqual(runtime.getSnapshot().gaze, { x: 0.8, y: -0.2, active: false });
  assert.equal(effects.frames.length, disabledFrameCount);

  runtime.dispatch({ type: 'user.gaze-follow-enabled' });
  assert.deepEqual(runtime.getSnapshot().gaze, { x: 0.8, y: -0.2, active: true });
  assert.equal(effects.frames.at(-1)?.ParamEyeBallX, 0.8);
});

test('out-of-order TTS completion still produces sequence-ordered playback', () => {
  const effects = new ControlledEffects();
  const runtime = createRuntime(effects);
  runtime.dispatch({ type: 'plan.submitted', plan: threeSegmentPlan() });
  assert.equal(runtime.getSnapshot().state, 'thinking');

  effects.resolveTts(2);
  assert.deepEqual(effects.playedSegments, []);
  effects.resolveTts(0);
  assert.deepEqual(effects.playedSegments, ['segment-0']);
  assert.equal(runtime.getSnapshot().state, 'speaking');

  effects.complete();
  assert.deepEqual(effects.playedSegments, ['segment-0']);
  effects.resolveTts(1);
  assert.deepEqual(effects.playedSegments, ['segment-0', 'segment-1']);
  effects.complete();
  assert.deepEqual(effects.playedSegments, ['segment-0', 'segment-1', 'segment-2']);
  effects.complete();

  assert.equal(runtime.getSnapshot().state, 'idle');
  assert.equal(runtime.getSnapshot().planId, null);
});

test('playback clock drives timeline, motion, and amplitude mouth frames', () => {
  const effects = new ControlledEffects();
  const runtime = createRuntime(effects);
  runtime.dispatch({ type: 'plan.submitted', plan: threeSegmentPlan() });
  effects.resolveTts(0, {
    delivery: 'artifact',
    requestId: 'voice-0',
    uri: 'memory://voice',
    mimeType: 'audio/wav',
    amplitude: [
      { atMs: 0, value: 0.1 },
      { atMs: 200, value: 0.8 },
    ],
  });

  assert.equal(runtime.getSnapshot().emotion.current, 'happy');
  effects.progress(199);
  assert.deepEqual(effects.motions, []);
  effects.progress(200);
  assert.deepEqual(effects.motions, ['nod-0']);
  assert.equal(runtime.getSnapshot().gesture.action, 'nod');
  assert.equal(effects.frames.at(-1)?.ParamMouthOpenY, 0.8);
});

test('stream playback levels drive mouth frames while buffering remains a player fact', () => {
  const effects = new ControlledEffects();
  const runtime = createRuntime(effects);
  runtime.dispatch({ type: 'plan.submitted', plan: threeSegmentPlan() });
  effects.resolveTts(0, {
    delivery: 'stream', requestId: 'stream-0', uri: 'http://127.0.0.1/audio/stream-0',
    mimeType: 'audio/pcm', codec: 'pcm_s16le', sampleRateHz: 24_000, channels: 1,
  });
  const generation = runtime.getSnapshot().generation;

  effects.progress(100);
  assert.equal(effects.frames.at(-1)?.ParamMouthOpenY, 0);
  runtime.dispatch({
    type: 'playback.level', generation, segmentId: 'segment-0', positionMs: 100, value: 1.4,
  });
  assert.equal(effects.frames.at(-1)?.ParamMouthOpenY, 1);

  runtime.dispatch({
    type: 'playback.stalled', generation, segmentId: 'segment-0', positionMs: 120,
  });
  assert.equal(runtime.getSnapshot().state, 'speaking');
  assert.equal(runtime.getSnapshot().playback.status, 'buffering');
  runtime.dispatch({
    type: 'playback.recovered', generation, segmentId: 'segment-0', positionMs: 120,
  });
  assert.equal(runtime.getSnapshot().playback.status, 'playing');
});

test('Runtime applies character lip-sync gain to stream facts and clamps the mouth parameter', () => {
  const effects = new ControlledEffects();
  const runtime = createRuntimeWithLipSyncGain(effects, 2.5);
  runtime.dispatch({ type: 'plan.submitted', plan: threeSegmentPlan() });
  effects.resolveTts(0, {
    delivery: 'stream', requestId: 'stream-gain', uri: 'http://127.0.0.1/audio/stream-gain',
    mimeType: 'audio/pcm', codec: 'pcm_s16le', sampleRateHz: 24_000, channels: 1,
  });
  const generation = runtime.getSnapshot().generation;

  runtime.dispatch({
    type: 'playback.level', generation, segmentId: 'segment-0', positionMs: 100, value: 0.224,
  });
  assert.equal(effects.frames.at(-1)?.ParamMouthOpenY, 0.56);
  runtime.dispatch({
    type: 'playback.level', generation, segmentId: 'segment-0', positionMs: 125, value: 0.8,
  });
  assert.equal(effects.frames.at(-1)?.ParamMouthOpenY, 1);
});

test('Runtime rejects an invalid lip-sync profile', () => {
  assert.throws(() => createRuntimeWithLipSyncGain(new ControlledEffects(), 0), /positive and finite/);
});

test('pause freezes timeline until playback resumes', () => {
  const effects = new ControlledEffects();
  const runtime = createRuntime(effects);
  runtime.dispatch({ type: 'plan.submitted', plan: threeSegmentPlan() });
  effects.resolveTts(0);

  runtime.dispatch({ type: 'user.pause-requested' });
  assert.equal(runtime.getSnapshot().playback.status, 'paused');
  effects.progress(500);
  assert.deepEqual(effects.motions, []);
  assert.equal(effects.frames.at(-1)?.ParamMouthOpenY, 0);

  runtime.dispatch({ type: 'user.resume-requested' });
  assert.equal(runtime.getSnapshot().playback.status, 'playing');
  effects.progress(500);
  assert.deepEqual(effects.motions, ['nod-0']);
});

test('a failed TTS segment is skipped without blocking later ready audio', () => {
  const effects = new ControlledEffects();
  const runtime = createRuntime(effects);
  runtime.dispatch({ type: 'plan.submitted', plan: threeSegmentPlan() });
  effects.resolveTts(1);
  effects.failTts(0);
  assert.deepEqual(effects.playedSegments, ['segment-1']);
  assert.equal(runtime.getSnapshot().lastError?.code, 'fake-tts-failed');
});

test('planner removes unsupported emotion, action, and gaze capabilities before execution', () => {
  const effects = new ControlledEffects();
  const runtime = new AvatarRuntime({
    planner: new DefaultAvatarPlanner(),
    mixer: new ParameterMixer(),
    effects,
  });
  runtime.dispatch({
    type: 'renderer.ready',
    capabilities: {
      emotions: ['neutral'],
      actions: [],
      parameters: ['ParamMouthOpenY'],
      supportsMouthForm: false,
      supportsGaze: false,
      supportsHitTest: false,
    },
  });
  runtime.dispatch({ type: 'plan.submitted', plan: threeSegmentPlan() });
  runtime.dispatch({ type: 'user.look-target-changed', x: 1, y: 1 });
  effects.resolveTts(0);
  effects.progress(500);
  assert.equal(runtime.getSnapshot().emotion.current, 'neutral');
  assert.equal(runtime.getSnapshot().gaze.active, false);
  assert.deepEqual(effects.motions, []);
});

test('interrupt cancels effects and rejects late events from the old generation', () => {
  const effects = new ControlledEffects();
  const runtime = createRuntime(effects);
  runtime.dispatch({ type: 'plan.submitted', plan: threeSegmentPlan() });
  effects.resolveTts(0);
  const oldGeneration = runtime.getSnapshot().generation;

  runtime.dispatch({ type: 'user.interrupt-requested' });
  assert.equal(runtime.getSnapshot().state, 'idle');
  assert.equal(runtime.getSnapshot().generation, oldGeneration + 1);
  assert.deepEqual(effects.cancelledGenerations, [oldGeneration]);
  assert.deepEqual(effects.stoppedGenerations, [oldGeneration]);

  runtime.dispatch({
    type: 'playback.completed',
    generation: oldGeneration,
    segmentId: 'segment-0',
    positionMs: 999,
  });
  assert.equal(runtime.getSnapshot().state, 'idle');
  assert.deepEqual(effects.playedSegments, ['segment-0']);
});

test('effect executor failures return to the runtime as error events', () => {
  const controlled = new ControlledEffects();
  const runtime = new AvatarRuntime({
    planner: new DefaultAvatarPlanner(),
    mixer: new ParameterMixer(),
    effects: {
      execute(effect: RuntimeEffect, dispatch: (event: AvatarEvent) => void): void {
        if (effect.type === 'tts.synthesize' && effect.segment.sequence === 0) {
          throw new Error('executor exploded');
        }
        controlled.execute(effect, dispatch);
      },
    },
  });
  runtime.dispatch({ type: 'renderer.ready', capabilities });
  runtime.dispatch({ type: 'plan.submitted', plan: threeSegmentPlan() });
  assert.equal(runtime.getSnapshot().lastError?.code, 'effect-failed');
  controlled.resolveTts(1);
  assert.deepEqual(controlled.playedSegments, ['segment-1']);
});

test('playback failure releases the current segment and continues with the next ready one', () => {
  const effects = new ControlledEffects();
  const runtime = createRuntime(effects);
  runtime.dispatch({ type: 'plan.submitted', plan: threeSegmentPlan() });
  effects.resolveTts(1);
  effects.resolveTts(0);
  const generation = runtime.getSnapshot().generation;
  runtime.dispatch({
    type: 'playback.failed',
    generation,
    segmentId: 'segment-0',
    error: { code: 'decode-failed', message: 'bad audio', recoverable: true },
  });
  assert.deepEqual(effects.playedSegments, ['segment-0', 'segment-1']);
  assert.equal(runtime.getSnapshot().lastError?.code, 'decode-failed');
});

test('plan completion returns expression state to neutral', () => {
  const effects = new ControlledEffects();
  const runtime = createRuntime(effects);
  runtime.dispatch({ type: 'plan.submitted', plan: {
    id: 'one',
    segments: [threeSegmentPlan().segments[0]!],
  } });
  effects.resolveTts(0);
  assert.equal(runtime.getSnapshot().emotion.current, 'happy');
  effects.complete();
  assert.equal(runtime.getSnapshot().state, 'idle');
  assert.equal(runtime.getSnapshot().emotion.current, 'neutral');
});

test('an active plan cannot be replaced without an explicit interrupt', () => {
  const effects = new ControlledEffects();
  const runtime = createRuntime(effects);
  runtime.dispatch({ type: 'plan.submitted', plan: threeSegmentPlan() });
  assert.throws(
    () => runtime.dispatch({ type: 'plan.submitted', plan: threeSegmentPlan() }),
    /already active/,
  );
});

test('unknown TTS results and duplicate playback completion cannot advance the plan', () => {
  const effects = new ControlledEffects();
  const runtime = createRuntime(effects);
  runtime.dispatch({ type: 'plan.submitted', plan: threeSegmentPlan() });
  runtime.dispatch({
    type: 'tts.segment-ready',
    generation: 0,
    segmentId: 'not-in-plan',
    sequence: 0,
    audio: {
      delivery: 'artifact', requestId: 'invalid',
      uri: 'memory://invalid', mimeType: 'audio/wav',
    },
  });
  assert.deepEqual(effects.playedSegments, []);

  effects.resolveTts(0);
  effects.complete();
  runtime.dispatch({
    type: 'playback.completed',
    generation: 0,
    segmentId: 'segment-0',
    positionMs: 1000,
  });
  effects.resolveTts(1);
  assert.deepEqual(effects.playedSegments, ['segment-0', 'segment-1']);
});
