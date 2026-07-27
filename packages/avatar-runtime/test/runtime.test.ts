import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AvatarEvent,
  CharacterActionCatalog,
  CharacterExpressionCatalog,
  PerformancePlan,
  RuntimeEffect,
} from '../../contracts/src/index.ts';
import { ParameterMixer } from '../src/mixer.ts';
import { DefaultAvatarPlanner } from '../src/planner.ts';
import { AvatarRuntime } from '../src/runtime.ts';
import { estimateTextFallbackDurationMs } from '../src/speech-bubble.ts';
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
    lipSyncProfile: { gain, attackMs: 0, releaseMs: 0, peakHoldMs: 0 },
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
  const initialFrameCount = effects.frames.length;
  let notifications = 0;
  runtime.subscribe(() => notifications++);
  runtime.dispatch({ type: 'user.look-target-changed', x: 0.5, y: -0.25 });
  assert.equal(effects.frames.length, initialFrameCount);
  const notificationsAfterTarget = notifications;
  runtime.dispatch({ type: 'renderer.frame-tick', deltaMs: 45 });
  assert.equal(notifications, notificationsAfterTarget);
  assert.ok(effects.frames.at(-1)!.ParamAngleX! > 0);
  assert.ok(effects.frames.at(-1)!.ParamAngleX! < 15);
  assert.ok(effects.frames.at(-1)!.ParamEyeBallX! > effects.frames.at(-1)!.ParamAngleX! / 30);
  runtime.dispatch({ type: 'renderer.frame-tick', deltaMs: 1_000 });
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
  runtime.dispatch({ type: 'renderer.frame-tick', deltaMs: 1_000 });
  runtime.dispatch({ type: 'plan.submitted', plan: threeSegmentPlan() });
  assert.equal(runtime.getSnapshot().gaze.active, true);
  assert.equal(effects.frames.at(-1)?.ParamEyeBallX, -0.4);

  runtime.dispatch({ type: 'user.interrupt-requested' });
  assert.deepEqual(runtime.getSnapshot().gaze, { x: -0.4, y: 0.6, active: true });
  assert.equal(effects.frames.at(-1)?.ParamEyeBallY, 0.6);

  runtime.dispatch({ type: 'user.gaze-follow-disabled' });
  assert.equal(runtime.getSnapshot().gaze.active, false);
  runtime.dispatch({ type: 'renderer.frame-tick', deltaMs: 1_000 });
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
  assert.equal(effects.frames.length, disabledFrameCount);
  runtime.dispatch({ type: 'renderer.frame-tick', deltaMs: 1_000 });
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
  assert.equal(runtime.getSnapshot().gesture.actionId, 'nod');
  const openingValue = effects.frames.at(-1)?.ParamMouthOpenY ?? 0;
  assert.ok(openingValue > 0.1 && openingValue < 0.8);
  effects.progress(230);
  assert.ok((effects.frames.at(-1)?.ParamMouthOpenY ?? 0) > openingValue);
});

test('timeline action intents resolve character-owned bindings before reaching Renderer', () => {
  const effects = new ControlledEffects();
  const actionCatalog: CharacterActionCatalog = {
    revision: 1,
    descriptors: [{
      actionId: 'reviewed-wave',
      label: 'Reviewed wave',
      semanticTags: ['greeting'],
      prototypeTexts: ['Hello'],
      allowedAnchors: ['segment-start'],
      compatibleAvatarStates: ['thinking', 'speaking'],
      scene: { anyTags: ['desktop'], postures: ['standing'] },
      speech: 'allow',
      priority: 20,
      cooldownMs: 0,
      maxQueueAgeMs: 5000,
      busyPolicy: 'enqueue',
      triggers: [{
        ruleId: 'performance',
        trigger: 'performance.action',
        mode: 'required',
        chance: 1,
        weight: 1,
      }],
    }],
    bindings: {
      'reviewed-wave': {
        type: 'live2d-motion',
        group: 'TapBody',
        index: 4,
        mode: 'once',
        expectedDurationMs: 9367,
      },
    },
  };
  const runtime = new AvatarRuntime({
    planner: new DefaultAvatarPlanner(),
    mixer: new ParameterMixer({ ranges: {} }),
    effects,
    actionCatalog,
    sceneActionContext: {
      generation: 1,
      revision: 0,
      sceneId: 'desktop',
      tags: ['desktop'],
      posture: 'standing',
      allowedActionTags: [],
      blockedActionTags: [],
      triggerChanceMultipliers: {},
    },
  });
  runtime.dispatch({
    type: 'renderer.ready',
    capabilities: { ...capabilities, actions: ['reviewed-wave'] },
  });
  runtime.dispatch({
    type: 'plan.submitted',
    plan: {
      id: 'bound-action',
      segments: [{
        id: 'bound-segment',
        sequence: 0,
        displayText: 'hello',
        speechText: 'hello',
        actions: [{ id: 'request-1', action: 'reviewed-wave', atMs: 0 }],
      }],
    },
  });
  effects.resolveTts(0);

  assert.deepEqual(effects.motionCommands, [{
    requestId: 'request-1',
    actionId: 'reviewed-wave',
    binding: {
      type: 'live2d-motion',
      group: 'TapBody',
      index: 4,
      mode: 'once',
      expectedDurationMs: 9367,
    },
    priority: 20,
  }]);
  assert.deepEqual(runtime.getSnapshot().gesture, {
    requestId: 'request-1',
    actionId: 'reviewed-wave',
    queueLength: 0,
  });
});

test('a restrictive expression interrupts an already playing incompatible action', () => {
  const effects = new ControlledEffects();
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const expressionCatalog: CharacterExpressionCatalog = {
    revision: 1,
    defaultExpressionKey: 'neutral',
    descriptors: [{
      expressionKey: 'neutral',
      label: 'Neutral',
      semanticTags: ['neutral'],
      prototypeTexts: ['Okay.'],
      baseWeight: 1,
      cooldownMs: 0,
      holdMs: { minMs: 0, maxMs: 0 },
      compatibleAvatarStates: ['idle', 'thinking', 'speaking'],
    }, {
      expressionKey: 'sad',
      label: 'Sad',
      semanticTags: ['sad'],
      prototypeTexts: ['That is unfortunate.'],
      blockedActionTags: ['ambient'],
      baseWeight: 1,
      cooldownMs: 0,
      holdMs: { minMs: 500, maxMs: 1_000 },
      compatibleAvatarStates: ['idle', 'thinking', 'speaking'],
    }],
    bindings: {
      neutral: { expression: 'exp-neutral' },
      sad: { expression: 'exp-sad' },
    },
  };
  const actionCatalog: CharacterActionCatalog = {
    revision: 1,
    descriptors: [{
      actionId: 'ambient-sway',
      label: 'Ambient sway',
      semanticTags: ['ambient', 'relaxed'],
      prototypeTexts: ['A relaxed idle sway'],
      allowedAnchors: ['segment-start'],
      compatibleAvatarStates: ['thinking', 'speaking'],
      scene: {},
      speech: 'allow',
      priority: 10,
      cooldownMs: 0,
      maxQueueAgeMs: 5_000,
      busyPolicy: 'enqueue',
      triggers: [{
        ruleId: 'performance',
        trigger: 'performance.action',
        mode: 'required',
        chance: 1,
        weight: 1,
      }],
    }],
    bindings: {
      'ambient-sway': {
        type: 'live2d-motion',
        group: 'TapBody',
        index: 1,
        mode: 'once',
        expectedDurationMs: 4_400,
      },
    },
  };
  const runtime = new AvatarRuntime({
    planner: new DefaultAvatarPlanner(),
    mixer: new ParameterMixer({ ranges: {} }),
    effects,
    expressionCatalog,
    actionCatalog,
    performanceLogger: (event, data) => logs.push({ event, data }),
    clock: () => 2_000,
  });
  runtime.dispatch({
    type: 'renderer.ready',
    capabilities: { ...capabilities, actions: ['ambient-sway'] },
  });
  runtime.dispatch({
    type: 'plan.submitted',
    plan: {
      id: 'expression-action-conflict',
      segments: [{
        id: 'conflict-segment',
        sequence: 0,
        displayText: '先放松一下。不过这确实令人难过。',
        speechText: '先放松一下。不过这确实令人难过。',
        actions: [{ id: 'ambient-at-start', action: 'ambient-sway', atMs: 0 }],
        expressionCues: [{ expressionKey: 'sad', intensity: 0.9, atMs: 1_000 }],
      }],
    },
  });
  effects.resolveTts(0);

  assert.deepEqual(effects.motions, ['ambient-at-start']);
  assert.equal(runtime.getSnapshot().gesture.actionId, 'ambient-sway');

  effects.progress(1_000);

  assert.deepEqual(effects.stoppedMotionRequests, ['ambient-at-start']);
  assert.equal(runtime.getSnapshot().expression.currentKey, 'sad');
  assert.equal(runtime.getSnapshot().gesture.actionId, null);
  assert.deepEqual(
    logs.find(log => log.event === 'action.interrupted-by-expression')?.data,
    {
      expressionKey: 'sad',
      blockedActionTags: ['ambient'],
      actionId: 'ambient-sway',
      requestId: 'ambient-at-start',
    },
  );
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

test('a failed TTS segment presents complete text before advancing to later ready audio', () => {
  const effects = new ControlledEffects();
  const runtime = createRuntime(effects);
  const plan = threeSegmentPlan();
  plan.segments[0]!.bubble = { mode: 'stream', charactersPerSecond: 20 };
  runtime.dispatch({ type: 'plan.submitted', plan });
  effects.resolveTts(1);
  effects.failTts(0);

  const fallback = runtime.getSnapshot().speechBubble;
  assert.equal(runtime.getSnapshot().state, 'presenting');
  assert.equal(fallback.displayText, 'text-0');
  assert.equal(fallback.config?.mode, 'complete');
  assert.deepEqual(effects.playedSegments, []);
  assert.equal(effects.frames.at(-1)?.ParamMouthOpenY, 0);
  assert.equal(
    effects.pendingBubbleDismissals.get(fallback.presentationId)?.effect.delayMs,
    estimateTextFallbackDurationMs('text-0'),
  );
  effects.dismissBubble(fallback.presentationId);

  assert.deepEqual(effects.playedSegments, ['segment-1']);
  assert.equal(runtime.getSnapshot().lastError?.code, 'fake-tts-failed');
});

test('multiple failed TTS segments use ordered text fallbacks instead of replacing each other', () => {
  const effects = new ControlledEffects();
  const runtime = createRuntime(effects);
  runtime.dispatch({ type: 'plan.submitted', plan: threeSegmentPlan() });
  effects.failTts(1);
  effects.resolveTts(2);
  effects.failTts(0);

  const first = runtime.getSnapshot().speechBubble;
  assert.equal(first.displayText, 'text-0');
  effects.dismissBubble(first.presentationId);

  const second = runtime.getSnapshot().speechBubble;
  assert.equal(runtime.getSnapshot().state, 'presenting');
  assert.equal(second.displayText, 'text-1');
  assert.ok(second.presentationId > first.presentationId);
  effects.dismissBubble(second.presentationId);

  assert.deepEqual(effects.playedSegments, ['segment-2']);
});

test('interrupt cancels an active text fallback without advancing the failed plan', () => {
  const effects = new ControlledEffects();
  const runtime = createRuntime(effects);
  runtime.dispatch({ type: 'plan.submitted', plan: threeSegmentPlan() });
  effects.failTts(0);
  const presentationId = runtime.getSnapshot().speechBubble.presentationId;

  runtime.dispatch({ type: 'user.interrupt-requested' });

  assert.equal(runtime.getSnapshot().state, 'idle');
  assert.equal(runtime.getSnapshot().speechBubble.phase, 'hidden');
  assert.deepEqual(effects.cancelledBubbleDismissals, [presentationId]);
  assert.deepEqual(effects.playedSegments, []);
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
  const fallback = runtime.getSnapshot().speechBubble;
  assert.equal(runtime.getSnapshot().state, 'presenting');
  assert.equal(fallback.displayText, 'text-0');
  controlled.dismissBubble(fallback.presentationId);
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

test('plan completion applies the scene chance boost and can start a post-conversation action', () => {
  const effects = new ControlledEffects();
  const actionCatalog: CharacterActionCatalog = {
    revision: 1,
    descriptors: [{
      actionId: 'post-chat-wave',
      label: 'Post-chat wave',
      semanticTags: ['ambient'],
      prototypeTexts: ['A relaxed response after talking'],
      allowedAnchors: ['segment-start'],
      compatibleAvatarStates: ['idle'],
      scene: { anyTags: ['desktop'] },
      speech: 'deny',
      priority: 10,
      cooldownMs: 0,
      maxQueueAgeMs: 5_000,
      busyPolicy: 'enqueue',
      triggers: [{
        ruleId: 'conversation',
        trigger: 'conversation.completed',
        mode: 'optional',
        chance: 0.18,
        weight: 1,
      }],
    }],
    bindings: {
      'post-chat-wave': {
        type: 'live2d-motion',
        group: 'TapBody',
        index: 2,
        mode: 'once',
        expectedDurationMs: 1_000,
      },
    },
  };
  const randomValues = [0, 0.4];
  const runtime = new AvatarRuntime({
    planner: new DefaultAvatarPlanner(),
    mixer: new ParameterMixer({ ranges: {} }),
    effects,
    actionCatalog,
    sceneActionContext: {
      generation: 1,
      revision: 0,
      sceneId: 'desktop',
      tags: ['desktop'],
      posture: 'standing',
      allowedActionTags: [],
      blockedActionTags: [],
      triggerChanceMultipliers: { 'conversation.completed': 3 },
    },
    actionRandom: () => randomValues.shift() ?? 0,
    clock: () => 2_000,
  });
  runtime.dispatch({
    type: 'renderer.ready',
    capabilities: { ...capabilities, actions: ['post-chat-wave'] },
  });
  runtime.dispatch({
    type: 'plan.submitted',
    plan: {
      id: 'post-chat-plan',
      segments: [{
        id: 'post-chat-segment',
        sequence: 0,
        displayText: '刚才聊得很开心。',
        speechText: '刚才聊得很开心。',
      }],
    },
  });
  effects.resolveTts(0);
  assert.equal(effects.motionCommands.length, 0);

  effects.complete();

  assert.equal(runtime.getSnapshot().state, 'idle');
  assert.equal(runtime.getSnapshot().gesture.actionId, 'post-chat-wave');
  assert.equal(effects.motionCommands.at(-1)?.actionId, 'post-chat-wave');
  assert.deepEqual(effects.motionCommands.at(-1)?.binding, {
    type: 'live2d-motion',
    group: 'TapBody',
    index: 2,
    mode: 'once',
    expectedDurationMs: 1_000,
  });
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
