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
      textAnchor: structuredClone(pending.effect.request.textAnchor),
      expressionTrigger: pending.effect.request.text,
      expressionTextAnchor: structuredClone(pending.effect.request.textAnchor),
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

test('Runtime analyzes natural clauses independently and binds text anchors to playback duration', () => {
  const effects = new ControlledEffects();
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const runtime = createRuntime(effects, logs);
  runtime.dispatch({
    type: 'plan.submitted',
    plan: {
      id: 'multi-clause-plan',
      segments: [{
        id: 'multi-clause-segment',
        sequence: 0,
        displayText: '太好了！不过还要再确认一下。',
        speechText: '太好了！不过还要再确认一下。',
      }],
    },
  });

  assert.equal(effects.pendingPerformanceV2.size, 2);
  const first = effects.pendingPerformanceV2.get('multi-clause-segment:clause-0');
  const second = effects.pendingPerformanceV2.get('multi-clause-segment:clause-1');
  assert.equal(first?.effect.request.text, '太好了！');
  assert.equal(second?.effect.request.text, '不过还要再确认一下。');
  assert.equal(second?.effect.request.actions.length, 0);

  effects.resolvePerformanceV2('multi-clause-segment:clause-1', {
    expressionTrigger: '确认',
    expressionTextAnchor: {
      ...second!.effect.request.textAnchor,
      startCharacter: second!.effect.request.textAnchor.startCharacter + 5,
      endCharacter: second!.effect.request.textAnchor.startCharacter + 7,
    },
    expressionCandidates: [{
      expressionKey: 'neutral',
      confidence: 0.99,
      intensity: 0.2,
    }],
  });
  effects.resolvePerformanceV2('multi-clause-segment:clause-0', {
    expressionTrigger: '太好',
    expressionTextAnchor: {
      ...first!.effect.request.textAnchor,
      endCharacter: first!.effect.request.textAnchor.startCharacter + 2,
    },
    expressionCandidates: [{
      expressionKey: 'smile',
      confidence: 0.99,
      intensity: 0.8,
    }],
  });
  effects.resolveTts(0, {
    delivery: 'artifact',
    requestId: 'multi-clause-audio',
    uri: 'memory://multi-clause',
    mimeType: 'audio/wav',
    durationMs: 4_000,
    fallbackCharactersPerSecond: 4.31,
  });

  assert.equal(effects.expressions.at(-1)?.expressionKey, 'smile');
  const secondStartMs = Math.round(
    (second!.effect.request.textAnchor.startCharacter + 5)
    / second!.effect.request.textAnchor.totalCharacters
    * 4_000,
  );
  const secondClauseStartMs = Math.round(
    second!.effect.request.textAnchor.startCharacter
    / second!.effect.request.textAnchor.totalCharacters
    * 4_000,
  );
  effects.progress(secondClauseStartMs);
  assert.equal(effects.expressions.at(-1)?.expressionKey, 'smile');
  effects.progress(secondStartMs - 1);
  assert.equal(effects.expressions.at(-1)?.expressionKey, 'smile');
  effects.progress(secondStartMs);
  assert.equal(effects.expressions.at(-1)?.expressionKey, 'neutral');
  assert.equal(logs.filter(log => log.event === 'expression.clause-requested').length, 2);
  assert.deepEqual(
    logs.find(log => log.event === 'expression.timeline-started')?.data,
    {
      segmentId: 'multi-clause-segment',
      durationMs: 4_000,
      fallbackCharactersPerSecond: 4.31,
    },
  );
  assert.deepEqual(
    logs.filter(log => log.event === 'expression.cue-fired').map(log => ({
      expressionKey: log.data.expressionKey,
      timingBasis: log.data.timingBasis,
      plannedAtMs: log.data.plannedAtMs,
      actualPositionMs: log.data.actualPositionMs,
    })),
    [
      {
        expressionKey: 'smile',
        timingBasis: 'duration-ratio',
        plannedAtMs: 0,
        actualPositionMs: 0,
      },
      {
        expressionKey: 'neutral',
        timingBasis: 'duration-ratio',
        plannedAtMs: secondStartMs,
        actualPositionMs: secondStartMs,
      },
    ],
  );
});

function createRuntime(
  effects: ControlledEffects,
  logs?: Array<{ event: string; data: Record<string, unknown> }>,
): AvatarRuntime {
  const runtime = new AvatarRuntime({
    planner: new DefaultAvatarPlanner(),
    mixer: new ParameterMixer({ ranges: {} }),
    effects,
    clock: () => 1_000,
    expressionRandomSeed: 3,
    ...(logs ? { performanceLogger: (event, data) => logs.push({ event, data }) } : {}),
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
