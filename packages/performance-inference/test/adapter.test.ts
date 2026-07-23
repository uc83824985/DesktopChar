import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PERFORMANCE_PLANNING_CONTRACT_VERSION,
  type PerformancePlanningRequest,
} from '../../contracts/src/index.ts';
import {
  FallbackPerformanceInference,
  OpenAiCompatiblePerformanceAdapter,
  PerformanceInferenceError,
  PerformanceRuntimeEffectHandler,
  RuleBasedPerformanceInference,
  parseSuggestion,
} from '../src/index.ts';

function request(): PerformancePlanningRequest {
  return {
    contractVersion: PERFORMANCE_PLANNING_CONTRACT_VERSION,
    requestId: 'request-1',
    planId: 'plan-1',
    segmentId: 'segment-1',
    segmentRevision: 0,
    text: '你好，很高兴见到你！',
    persona: { id: 'mao', styleTags: ['friendly'] },
    scene: { id: 'desktop', modeTags: ['idle'] },
    avatar: { state: 'thinking', currentEmotion: 'neutral' },
    emotions: ['neutral', 'happy'],
    actions: [{
      actionId: 'greet',
      label: '挥手问候',
      tags: ['greeting'],
      allowedAnchors: ['segment-start'],
    }],
  };
}

test('OpenAI-compatible adapter uses portable request fields and validates fenced JSON', async () => {
  let received: Record<string, unknown> | undefined;
  const fetcher = (async function (
    this: typeof globalThis,
    _input: string | URL | Request,
    init?: RequestInit,
  ) {
    assert.equal(this, globalThis);
    received = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: '```json\n{"emotion":{"emotion":"happy","intensity":0.7,"confidence":0.9,"anchor":"segment-start"},"actions":[{"actionId":"greet","confidence":0.8,"anchor":"segment-start"}]}\n```',
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const adapter = new OpenAiCompatiblePerformanceAdapter({
    provider: 'qwen35-transformers',
    baseUrl: 'http://127.0.0.1:18090/v1/',
    timeoutMs: 1_000,
    maxOutputTokens: 96,
    temperature: 0.1,
  }, fetcher);

  const suggestion = await adapter.plan(request(), new AbortController().signal);

  assert.equal(suggestion.emotion?.emotion, 'happy');
  assert.equal(suggestion.actions[0]?.actionId, 'greet');
  assert.equal(received?.stream, false);
  assert.equal(received?.model, undefined);
  assert.equal(received?.extra_body, undefined);
  assert.equal(received?.top_k, undefined);
});

test('parser rejects actions and anchors outside the request capability whitelist', () => {
  assert.throws(
    () => parseSuggestion(
      '{"emotion":null,"actions":[{"actionId":"nod","confidence":0.8,"anchor":"segment-start"}]}',
      request(),
      'test',
    ),
    /not available/,
  );
  assert.throws(
    () => parseSuggestion(
      '{"emotion":null,"actions":[{"actionId":"greet","confidence":0.8,"anchor":"segment-end"}]}',
      request(),
      'test',
    ),
    /anchor is not allowed/,
  );
});

test('fallback adapter uses deterministic rules after a recoverable provider failure', async () => {
  const fallbacks: Array<{ error: unknown; requestId: string }> = [];
  const primary = {
    describe: () => ({
      structuredOutput: 'prompt-only' as const,
      thinkingControl: 'unsupported' as const,
      streaming: false,
    }),
    plan: async () => {
      throw new PerformanceInferenceError('offline', 'provider unavailable');
    },
  };
  const inference = new FallbackPerformanceInference(
    primary,
    new RuleBasedPerformanceInference(),
    {
      onFallback: (error, fallbackRequest) => {
        fallbacks.push({ error, requestId: fallbackRequest.requestId });
      },
    },
  );
  const suggestion = await inference.plan(request(), new AbortController().signal);
  assert.equal(suggestion.source, 'rules');
  assert.equal(suggestion.emotion?.emotion, 'happy');
  assert.equal(suggestion.actions[0]?.actionId, 'greet');
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0]?.requestId, 'request-1');
  assert.match(String(fallbacks[0]?.error), /provider unavailable/);
});

test('fallback adapter does not hide non-recoverable contract failures', async () => {
  const primary = {
    describe: () => ({
      structuredOutput: 'prompt-only' as const,
      thinkingControl: 'unsupported' as const,
      streaming: false,
    }),
    plan: async () => {
      throw new PerformanceInferenceError('bad-contract', 'unsupported contract', {
        recoverable: false,
      });
    },
  };
  const inference = new FallbackPerformanceInference(primary, new RuleBasedPerformanceInference());
  await assert.rejects(
    inference.plan(request(), new AbortController().signal),
    /unsupported contract/,
  );
});

test('runtime effect handler translates inference completion and cancellation into Runtime events', async () => {
  type Suggestion = Awaited<ReturnType<RuleBasedPerformanceInference['plan']>>;
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
  const handler = new PerformanceRuntimeEffectHandler(port);
  const events: unknown[] = [];
  const effect = { type: 'performance.infer' as const, generation: 3, request: request() };
  assert.equal(handler.handle(effect, event => events.push(event)), true);
  resolvePlan!(await new RuleBasedPerformanceInference().plan(request(), new AbortController().signal));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal((events[0] as { type: string }).type, 'performance.suggestion-ready');

  assert.equal(handler.handle({ type: 'performance.cancel', generation: 3 }, event => events.push(event)), true);
  assert.equal(handler.handle({ type: 'tts.cancel', generation: 3 }, event => events.push(event)), false);
});
