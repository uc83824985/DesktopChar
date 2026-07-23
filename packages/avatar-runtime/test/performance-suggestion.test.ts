import assert from 'node:assert/strict';
import test from 'node:test';
import type { PerformancePlan } from '../../contracts/src/index.ts';
import { AvatarRuntime } from '../src/runtime.ts';
import { ParameterMixer } from '../src/mixer.ts';
import { DefaultAvatarPlanner } from '../src/planner.ts';
import { ControlledEffects } from './fakes.ts';
import { capabilities } from './helpers.ts';

function runtimeWithPerformance(effects: ControlledEffects): AvatarRuntime {
  const runtime = new AvatarRuntime({
    planner: new DefaultAvatarPlanner(),
    mixer: new ParameterMixer({
      ranges: {
        ParamMouthOpenY: { min: 0, max: 1 },
        ParamMouthForm: { min: -1, max: 1 },
      },
    }),
    effects,
    performancePlanning: {
      persona: { id: 'mao', styleTags: ['friendly'] },
      scene: { id: 'desktop', modeTags: ['idle'] },
      actions: [{
        actionId: 'nod',
        label: '点头',
        tags: ['affirmation'],
        allowedAnchors: ['segment-start'],
      }],
    },
    emotionBindings: {
      neutral: { expression: null },
      happy: { expression: 'exp_02' },
    },
  });
  runtime.dispatch({ type: 'renderer.ready', capabilities });
  return runtime;
}

function inferredPlan(): PerformancePlan {
  return {
    id: 'inferred',
    segments: [{
      id: 'segment-0',
      sequence: 0,
      displayText: '当然可以。',
      speechText: '当然可以。',
    }],
  };
}

test('performance inference starts beside TTS and fills only Runtime-approved missing cues', () => {
  const effects = new ControlledEffects();
  const runtime = runtimeWithPerformance(effects);
  runtime.dispatch({ type: 'plan.submitted', plan: inferredPlan() });

  assert.equal(effects.pendingTts.has(0), true);
  assert.equal(effects.pendingPerformance.has('segment-0'), true);
  effects.resolvePerformance('segment-0', {
    emotion: {
      emotion: 'happy',
      intensity: 0.75,
      confidence: 0.9,
      anchor: 'segment-start',
    },
    actions: [{
      actionId: 'nod',
      confidence: 0.8,
      anchor: 'segment-start',
    }],
  });

  assert.equal(runtime.getActiveSegment()?.emotion?.emotion, 'happy');
  assert.equal(runtime.getActiveSegment()?.actions?.[0]?.action, 'nod');
});

test('late inference updates the active timeline and does not wait for another playback tick', () => {
  const effects = new ControlledEffects();
  const runtime = runtimeWithPerformance(effects);
  runtime.dispatch({ type: 'plan.submitted', plan: inferredPlan() });
  effects.resolveTts(0);
  effects.progress(500);

  effects.resolvePerformance('segment-0', {
    emotion: {
      emotion: 'happy',
      intensity: 0.7,
      confidence: 0.9,
      anchor: 'segment-start',
    },
    actions: [{
      actionId: 'nod',
      confidence: 0.9,
      anchor: 'segment-start',
    }],
  });

  assert.equal(runtime.getSnapshot().emotion.current, 'happy');
  assert.deepEqual(effects.expressions.at(-1), {
    emotion: 'happy',
    expressionId: 'exp_02',
    intensity: 0.7,
  });
  assert.deepEqual(effects.motions, ['performance:segment-0:0:nod']);
  effects.progress(600);
  assert.deepEqual(effects.motions, ['performance:segment-0:0:nod']);
});

test('character emotion binding resets its Live2D expression when the plan completes', () => {
  const effects = new ControlledEffects();
  const runtime = runtimeWithPerformance(effects);
  runtime.dispatch({ type: 'plan.submitted', plan: inferredPlan() });
  effects.resolvePerformance('segment-0', {
    emotion: {
      emotion: 'happy',
      intensity: 0.8,
      confidence: 0.9,
      anchor: 'segment-start',
    },
    actions: [],
  });
  effects.resolveTts(0);

  assert.equal(effects.expressions.at(-1)?.expressionId, 'exp_02');
  effects.complete();
  assert.deepEqual(effects.expressions.at(-1), {
    emotion: 'neutral',
    expressionId: null,
    intensity: 0,
  });
});

test('explicit plan cues are authoritative and do not request model replacement', () => {
  const effects = new ControlledEffects();
  const runtime = runtimeWithPerformance(effects);
  const plan = inferredPlan();
  plan.segments[0]!.emotion = { emotion: 'neutral', intensity: 0.2 };
  plan.segments[0]!.actions = [];
  runtime.dispatch({ type: 'plan.submitted', plan });

  assert.equal(effects.pendingPerformance.size, 0);
  assert.equal(runtime.getActiveSegment()?.emotion?.emotion, 'neutral');
});

test('interrupt cancels pending performance inference with the old Runtime generation', () => {
  const effects = new ControlledEffects();
  const runtime = runtimeWithPerformance(effects);
  runtime.dispatch({ type: 'plan.submitted', plan: inferredPlan() });
  runtime.dispatch({ type: 'user.interrupt-requested' });

  assert.deepEqual(effects.cancelledPerformanceGenerations, [0]);
  assert.equal(effects.pendingPerformance.size, 0);
});

test('reused plan and segment IDs cannot accept a late suggestion from an earlier request', () => {
  const effects = new ControlledEffects();
  const runtime = runtimeWithPerformance(effects);
  runtime.dispatch({ type: 'plan.submitted', plan: inferredPlan() });
  const old = effects.pendingPerformance.get('segment-0')!;
  effects.resolveTts(0);
  effects.complete();

  runtime.dispatch({ type: 'plan.submitted', plan: inferredPlan() });
  old.dispatch({
    type: 'performance.suggestion-ready',
    generation: old.effect.generation,
    planId: old.effect.request.planId,
    suggestion: {
      contractVersion: old.effect.request.contractVersion,
      requestId: old.effect.request.requestId,
      segmentId: old.effect.request.segmentId,
      segmentRevision: old.effect.request.segmentRevision,
      source: 'model',
      provider: 'late-old-request',
      emotion: {
        emotion: 'happy',
        intensity: 1,
        confidence: 1,
        anchor: 'segment-start',
      },
      actions: [],
    },
  });

  assert.equal(runtime.getActiveSegment()?.emotion, undefined);
  assert.notEqual(
    effects.pendingPerformance.get('segment-0')?.effect.request.requestId,
    old.effect.request.requestId,
  );
});
