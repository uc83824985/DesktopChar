import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PERFORMANCE_PLANNING_V2_CONTRACT_VERSION,
  type PerformancePlanningRequestV2,
} from '../../contracts/src/index.ts';
import {
  AdaptedPerformanceInferenceV2,
  ExpressionCatalogPlanningAdapter,
  FallbackPerformanceInferenceV2,
  OpenAiCompatiblePerformanceTransport,
  PerformanceInferenceError,
  PerformanceRuntimeEffectHandlerV2,
  RuleBasedExpressionCatalogInference,
  type PerformanceModelRequest,
} from '../src/index.ts';

test('v2 domain adapter exposes semantic descriptors but never renderer assets', async () => {
  let prepared: PerformanceModelRequest | undefined;
  const transport = {
    describe: () => ({
      structuredOutput: 'prompt-only' as const,
      thinkingControl: 'unsupported' as const,
      streaming: false,
    }),
    complete: async (modelRequest: PerformanceModelRequest) => {
      prepared = modelRequest;
      return {
        provider: 'fixture-model',
        text: JSON.stringify({
          affect: {
            valence: 0.9,
            arousal: 0.6,
            approval: 0.8,
            engagement: 0.9,
            certainty: 0.8,
          },
          expressionCandidates: [{
            expressionKey: 'closed-eye-smile',
            confidence: 0.91,
            intensity: 0.72,
          }],
          actions: [{ actionId: 'nod', confidence: 0.7, anchor: 'segment-start' }],
        }),
      };
    },
  };
  const inference = new AdaptedPerformanceInferenceV2(
    transport,
    new ExpressionCatalogPlanningAdapter({ maxOutputTokens: 192, temperature: 0.1 }),
  );
  const result = await inference.plan(request(), new AbortController().signal);
  assert.equal(result.contractVersion, PERFORMANCE_PLANNING_V2_CONTRACT_VERSION);
  assert.equal(result.catalogRevision, 3);
  assert.equal(result.expressionCandidates[0]?.expressionKey, 'closed-eye-smile');
  assert.equal(result.actions[0]?.actionId, 'nod');
  assert.ok(prepared);
  assert.equal(prepared.maxOutputTokens, 192);
  const input = JSON.parse(prepared.input) as {
    expressionCatalog: Array<Record<string, unknown>>;
  };
  assert.deepEqual(
    input.expressionCatalog.map(item => item.expressionKey),
    ['neutral', 'closed-eye-smile', 'disdain'],
  );
  for (const descriptor of input.expressionCatalog) {
    assert.equal('expression' in descriptor, false);
    assert.equal('binding' in descriptor, false);
    assert.equal('resource' in descriptor, false);
  }
  assert.doesNotMatch(prepared.input, /exp_0[1-8]/u);
});

test('v2 parser rejects unknown, duplicate and out-of-range model output', () => {
  const adapter = new ExpressionCatalogPlanningAdapter({
    maxOutputTokens: 192,
    temperature: 0.1,
  });
  assert.throws(
    () => adapter.parse({
      provider: 'fixture',
      text: '{"affect":null,"expressionCandidates":[{"expressionKey":"exp_02","confidence":1,"intensity":1}],"actions":[]}',
    }, request()),
    /available and unique/,
  );
  assert.throws(
    () => adapter.parse({
      provider: 'fixture',
      text: '{"affect":null,"expressionCandidates":[{"expressionKey":"disdain","confidence":0.8,"intensity":0.5},{"expressionKey":"disdain","confidence":0.7,"intensity":0.4}],"actions":[]}',
    }, request()),
    /available and unique/,
  );
  assert.throws(
    () => adapter.parse({
      provider: 'fixture',
      text: '{"affect":{"valence":2,"arousal":0,"approval":0,"engagement":0,"certainty":0},"expressionCandidates":[],"actions":[]}',
    }, request()),
    /valence must be from -1 to 1/,
  );
});

test('deterministic catalog rules remain usable without any model transport', async () => {
  const inference = new RuleBasedExpressionCatalogInference();
  const result = await inference.plan(
    { ...request(), text: '……你是认真的吗？这就有点让人无语了。' },
    new AbortController().signal,
  );
  assert.equal(result.source, 'rules');
  assert.equal(result.provider, 'deterministic-catalog-rules');
  assert.equal(result.expressionCandidates[0]?.expressionKey, 'disdain');
  assert.ok((result.affect?.approval ?? 0) < 0);
});

test('v2 fallback changes inference implementation without changing the domain contract', async () => {
  const primary = {
    describe: () => ({
      structuredOutput: 'prompt-only' as const,
      thinkingControl: 'unsupported' as const,
      streaming: false,
    }),
    plan: async () => {
      throw new PerformanceInferenceError('offline', 'model unavailable');
    },
  };
  const inference = new FallbackPerformanceInferenceV2(
    primary,
    new RuleBasedExpressionCatalogInference(),
  );
  const result = await inference.plan(request(), new AbortController().signal);
  assert.equal(result.contractVersion, PERFORMANCE_PLANNING_V2_CONTRACT_VERSION);
  assert.equal(result.source, 'rules');
});

test('OpenAI-compatible transport contains only generic text-generation concerns', async () => {
  let body: Record<string, unknown> | undefined;
  const fetcher = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const transport = new OpenAiCompatiblePerformanceTransport({
    provider: 'replaceable-provider',
    baseUrl: 'http://127.0.0.1:18090/v1/',
    model: 'replaceable-model',
    timeoutMs: 1_000,
  }, fetcher);
  const result = await transport.complete({
    instructions: 'instructions',
    input: 'input',
    maxOutputTokens: 32,
    temperature: 0,
  }, new AbortController().signal);
  assert.equal(result.provider, 'replaceable-provider');
  assert.equal(result.text, '{"ok":true}');
  assert.equal(body?.model, 'replaceable-model');
  assert.equal(body?.stream, false);
  assert.equal(body?.response_format, undefined);
  assert.equal(body?.tool_choice, undefined);
});

test('v2 effect handler preserves catalog identity and supports cancellation', async () => {
  type Suggestion = Awaited<ReturnType<RuleBasedExpressionCatalogInference['plan']>>;
  let resolvePlan: ((value: Suggestion) => void) | undefined;
  const port = {
    describe: () => ({
      structuredOutput: 'json-object' as const,
      thinkingControl: 'unsupported' as const,
      streaming: false,
    }),
    plan: () => new Promise<Suggestion>(resolve => {
      resolvePlan = resolve;
    }),
  };
  const handler = new PerformanceRuntimeEffectHandlerV2(port);
  const events: unknown[] = [];
  const planned = request();
  assert.equal(handler.handle({
    type: 'performance.infer-v2',
    generation: 4,
    request: planned,
  }, event => events.push(event)), true);
  resolvePlan!(await new RuleBasedExpressionCatalogInference().plan(
    planned,
    new AbortController().signal,
  ));
  await new Promise(resolve => setTimeout(resolve, 0));
  const ready = events[0] as {
    type: string;
    suggestion: { catalogRevision: number };
  };
  assert.equal(ready.type, 'performance.suggestion-v2-ready');
  assert.equal(ready.suggestion.catalogRevision, planned.catalogRevision);
  assert.equal(handler.handle({
    type: 'performance.cancel-v2',
    generation: 4,
  }, event => events.push(event)), true);
  assert.equal(handler.handle({
    type: 'performance.cancel',
    generation: 4,
  }, event => events.push(event)), false);
});

function request(): PerformancePlanningRequestV2 {
  const compatibleAvatarStates = ['idle', 'listening', 'thinking', 'speaking', 'presenting'] as const;
  return {
    contractVersion: PERFORMANCE_PLANNING_V2_CONTRACT_VERSION,
    requestId: 'request-v2-1',
    planId: 'plan-1',
    segmentId: 'segment-1',
    segmentRevision: 2,
    catalogRevision: 3,
    defaultExpressionKey: 'neutral',
    text: '好的，我很高兴。',
    persona: { id: 'mao', styleTags: ['friendly'] },
    scene: { id: 'desktop', modeTags: ['idle'] },
    avatar: { state: 'thinking', currentExpressionKey: 'neutral', coarseEmotion: 'neutral' },
    expressions: [
      {
        expressionKey: 'neutral',
        label: '中立',
        semanticTags: ['neutral'],
        prototypeTexts: ['好的。'],
        affectPrototype: { valence: 0, arousal: 0.1 },
        baseWeight: 1,
        cooldownMs: 0,
        holdMs: { minMs: 400, maxMs: 900 },
        compatibleAvatarStates: [...compatibleAvatarStates],
      },
      {
        expressionKey: 'closed-eye-smile',
        label: '闭眼微笑',
        semanticTags: ['happy', 'warm', 'friendly'],
        prototypeTexts: ['太好了！'],
        affectPrototype: { valence: 0.9, arousal: 0.6, approval: 0.8 },
        baseWeight: 1,
        cooldownMs: 1_000,
        holdMs: { minMs: 900, maxMs: 2_000 },
        compatibleAvatarStates: [...compatibleAvatarStates],
      },
      {
        expressionKey: 'disdain',
        label: '嫌弃无语',
        semanticTags: ['displeased', 'dismissive', 'speechless'],
        prototypeTexts: ['你是认真的吗？'],
        affectPrototype: { valence: -0.5, approval: -0.9 },
        baseWeight: 0.7,
        cooldownMs: 2_000,
        holdMs: { minMs: 800, maxMs: 1_900 },
        compatibleAvatarStates: [...compatibleAvatarStates],
      },
    ],
    actions: [{
      actionId: 'nod',
      label: '点头',
      tags: ['agreement'],
      allowedAnchors: ['segment-start'],
    }],
  };
}
