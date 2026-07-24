import assert from 'node:assert/strict';
import test from 'node:test';
import type { CharacterExpressionCatalog } from '../../contracts/src/index.ts';
import { AvatarRuntime, DefaultAvatarPlanner, ParameterMixer } from '../src/index.ts';
import { ControlledEffects } from './fakes.ts';
import { capabilities } from './helpers.ts';

test('Runtime requests v2 semantics, resolves expressionKey and applies only its local binding', () => {
  const effects = new ControlledEffects();
  const runtime = createRuntime(effects);
  runtime.dispatch({
    type: 'plan.submitted',
    plan: {
      id: 'catalog-plan',
      segments: [{
        id: 'catalog-segment',
        sequence: 0,
        displayText: '太好了，谢谢你！',
        speechText: '太好了，谢谢你！',
      }],
    },
  });
  const pending = effects.pendingPerformanceV2.get('catalog-segment');
  assert.ok(pending);
  assert.equal(effects.pendingPerformance.size, 0);
  assert.equal(pending.effect.request.catalogRevision, 7);
  assert.deepEqual(
    pending.effect.request.expressions.map(item => item.expressionKey),
    ['neutral', 'smile'],
  );
  assert.equal('bindings' in pending.effect.request, false);
  assert.doesNotMatch(JSON.stringify(pending.effect.request), /exp_0[12]/u);

  effects.resolvePerformanceV2('catalog-segment', {
    affect: {
      valence: 0.9,
      arousal: 0.6,
      approval: 0.8,
      engagement: 0.9,
      certainty: 0.8,
    },
    expressionCandidates: [{
      expressionKey: 'smile',
      confidence: 0.95,
      intensity: 0.8,
    }],
  });
  effects.resolveTts(0);

  assert.deepEqual(effects.expressions[0], {
    expressionKey: 'smile',
    expressionId: 'exp_02',
    intensity: 0.8,
  });
  assert.equal(runtime.getSnapshot().expression.currentKey, 'smile');
  assert.equal(runtime.getSnapshot().expression.catalogRevision, 7);
  assert.equal(runtime.getSnapshot().expression.holdUntilMs, 2_800);

  effects.complete();
  assert.equal(runtime.getSnapshot().expression.currentKey, 'neutral');
  assert.deepEqual(effects.expressions.at(-1), {
    expressionKey: 'neutral',
    expressionId: 'exp_01',
    intensity: 0,
  });
});

test('Runtime rejects explicit unknown keys and stale catalog revisions', () => {
  const effects = new ControlledEffects();
  const runtime = createRuntime(effects);
  assert.throws(
    () => runtime.dispatch({
      type: 'plan.submitted',
      plan: {
        id: 'invalid',
        segments: [{
          id: 'invalid-segment',
          sequence: 0,
          displayText: 'invalid',
          speechText: 'invalid',
          expression: { expressionKey: 'exp_02', intensity: 1 },
        }],
      },
    }),
    /not available/,
  );

  runtime.dispatch({
    type: 'plan.submitted',
    plan: {
      id: 'stale-plan',
      segments: [{
        id: 'stale-segment',
        sequence: 0,
        displayText: 'hello',
        speechText: 'hello',
      }],
    },
  });
  const pending = effects.pendingPerformanceV2.get('stale-segment');
  assert.ok(pending);
  runtime.dispatch({
    type: 'performance.suggestion-v2-ready',
    generation: pending.effect.generation,
    planId: pending.effect.request.planId,
    suggestion: {
      contractVersion: pending.effect.request.contractVersion,
      requestId: pending.effect.request.requestId,
      segmentId: 'stale-segment',
      segmentRevision: pending.effect.request.segmentRevision,
      catalogRevision: 6,
      source: 'model',
      provider: 'stale-test',
      expressionCandidates: [{
        expressionKey: 'smile',
        confidence: 1,
        intensity: 1,
      }],
      actions: [],
    },
  });
  effects.resolveTts(0);
  assert.equal(effects.expressions.length, 0);
  assert.equal(runtime.getSnapshot().expression.currentKey, 'neutral');
});

function createRuntime(effects: ControlledEffects): AvatarRuntime {
  const runtime = new AvatarRuntime({
    planner: new DefaultAvatarPlanner(),
    mixer: new ParameterMixer({ ranges: {} }),
    effects,
    clock: () => 1_000,
    expressionRandomSeed: 3,
    expressionCatalog: catalog(),
    performancePlanning: {
      persona: { id: 'test', styleTags: ['friendly'] },
      scene: { id: 'desktop', modeTags: ['desktop'] },
      actions: [],
    },
  });
  runtime.dispatch({ type: 'renderer.ready', capabilities });
  return runtime;
}

function catalog(): CharacterExpressionCatalog {
  const compatibleAvatarStates = ['idle', 'listening', 'thinking', 'speaking', 'presenting'] as const;
  return {
    revision: 7,
    defaultExpressionKey: 'neutral',
    descriptors: [
      {
        expressionKey: 'neutral',
        label: 'Neutral',
        semanticTags: ['neutral'],
        prototypeTexts: ['Okay.'],
        affectPrototype: { valence: 0, arousal: 0.1 },
        baseWeight: 1,
        cooldownMs: 0,
        holdMs: { minMs: 400, maxMs: 900 },
        compatibleAvatarStates: [...compatibleAvatarStates],
      },
      {
        expressionKey: 'smile',
        label: 'Smile',
        semanticTags: ['happy', 'friendly'],
        prototypeTexts: ['Great!'],
        affectPrototype: { valence: 0.9, arousal: 0.6, approval: 0.8 },
        baseWeight: 1,
        cooldownMs: 1_000,
        holdMs: { minMs: 1_000, maxMs: 2_000 },
        compatibleAvatarStates: [...compatibleAvatarStates],
      },
    ],
    bindings: {
      neutral: { expression: 'exp_01' },
      smile: { expression: 'exp_02' },
    },
  };
}
