import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRouterAgentGateway,
  resolveHighConfidenceRoute,
  ROUTER_AGENT_OUTPUT_SCHEMA,
} from './router-agent.mjs';

test('managed Codex Router returns one structured suggestion without side effects', async () => {
  const calls = [];
  let closed = false;
  const gateway = createRouterAgentGateway({
    config: routerConfig(),
    codexClient: {
      async execute(request) {
        calls.push(request);
        return routeResult();
      },
      async close() {
        closed = true;
      },
    },
    loadProfile: async () => profile(2, '只判断是否属于候选任务。'),
  });
  const result = await gateway.decide(routerRequest(), new AbortController().signal);
  assert.equal(result.route.target.sessionId, 'session-2');
  assert.equal(calls[0].outputSchema, ROUTER_AGENT_OUTPUT_SCHEMA);
  assert.match(calls[0].prompt, /只判断是否属于候选任务/);
  assert.match(calls[0].prompt, /不要调用工具，不要提交任务/);
  assert.match(calls[0].prompt, /"visibleContextRevision":7/);
  assert.equal(gateway.snapshot().profileRevision, 2);
  assert.equal(gateway.snapshot().lastDecisionSource, 'provider');
  assert.ok(gateway.snapshot().lastDecisionLatencyMs >= 0);
  await gateway.close();
  assert.equal(closed, false);
});

test('explicit session references use the high-confidence path without loading a provider', async () => {
  let providerCalls = 0;
  let profileLoads = 0;
  const gateway = createRouterAgentGateway({
    config: routerConfig(),
    codexClient: {
      async execute() {
        providerCalls++;
        throw new Error('provider must not run');
      },
      async close() {},
    },
    loadProfile: async () => {
      profileLoads++;
      return profile(1, 'route');
    },
  });
  const result = await gateway.decide(routerRequest({
    message: {
      ...routerRequest().message,
      text: '请继续处理 session-2',
    },
  }), new AbortController().signal);
  assert.deepEqual(result.route, {
    decision: 'route',
    target: { kind: 'task-session', sessionId: 'session-2' },
    confidence: 0.99,
  });
  assert.equal(providerCalls, 0);
  assert.equal(profileLoads, 0);
  assert.equal(gateway.snapshot().lastDecisionSource, 'high-confidence');
});

test('a unique title plus a task action is a high-confidence session route', () => {
  const result = resolveHighConfidenceRoute(routerRequest({
    message: {
      ...routerRequest().message,
      text: '请继续处理第二个会话',
    },
  }));
  assert.equal(result.route.target.sessionId, 'session-2');
  assert.equal(result.candidates[0].score, 0.99);
});

test('short social messages use the character high-confidence path', () => {
  const result = resolveHighConfidenceRoute(routerRequest({
    message: {
      ...routerRequest().message,
      text: '我也很高兴！',
    },
  }));
  assert.deepEqual(result.route, {
    decision: 'route',
    target: { kind: 'character' },
    confidence: 0.99,
  });
  assert.equal(result.candidates[0].score, 0.01);
});

test('negated session mentions are not treated as high-confidence handoffs', () => {
  const result = resolveHighConfidenceRoute(routerRequest({
    message: {
      ...routerRequest().message,
      text: '不要继续处理 session-2',
    },
  }));
  assert.equal(result, undefined);
});

test('ambiguous task wording still requires the configured Router Provider', async () => {
  let providerCalls = 0;
  const gateway = createRouterAgentGateway({
    config: routerConfig(),
    codexClient: {
      async execute() {
        providerCalls++;
        return routeResult();
      },
      async close() {},
    },
    loadProfile: async () => profile(1, 'route'),
  });
  await gateway.decide(routerRequest(), new AbortController().signal);
  assert.equal(providerCalls, 1);
  assert.equal(gateway.snapshot().lastDecisionSource, 'provider');
});

test('Router Profile reload affects only requests that start after the edit', async () => {
  let revision = 1;
  const prompts = [];
  let releaseFirst;
  const firstWaiting = Promise.withResolvers();
  const gateway = createRouterAgentGateway({
    config: routerConfig(),
    codexClient: {
      async execute(request) {
        prompts.push(request.prompt);
        if (prompts.length === 1) {
          firstWaiting.resolve();
          await new Promise(resolve => { releaseFirst = resolve; });
        }
        return routeResult();
      },
      async close() {},
    },
    loadProfile: async () => profile(revision, `profile-${revision}`),
  });
  const first = gateway.decide(routerRequest(), new AbortController().signal);
  await firstWaiting.promise;
  revision = 2;
  const second = gateway.decide(routerRequest(), new AbortController().signal);
  releaseFirst();
  await Promise.all([first, second]);
  assert.match(prompts[0], /profile-1/);
  assert.doesNotMatch(prompts[0], /profile-2/);
  assert.match(prompts[1], /profile-2/);
  assert.equal(gateway.snapshot().profileRevision, 2);
});

test('OpenAI-compatible Router resolves its secret only for the request and never snapshots it', async () => {
  const secret = 'router-secret-value';
  let authorization;
  let body;
  const gateway = createRouterAgentGateway({
    config: routerConfig({
      adapter: 'openai-compatible',
      baseUrl: 'https://router.example/v1',
      model: 'router-model',
      apiKeyEnv: 'ROUTER_TEST_KEY',
      requestTimeoutMs: 5_000,
    }),
    env: { ROUTER_TEST_KEY: secret },
    codexClient: { async execute() {}, async close() {} },
    loadProfile: async () => profile(1, 'route'),
    fetch: async (url, init) => {
      assert.equal(url.href, 'https://router.example/v1/chat/completions');
      authorization = init.headers.authorization;
      body = JSON.parse(init.body);
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: routeResult() } }] };
        },
      };
    },
  });
  const result = await gateway.decide(routerRequest(), new AbortController().signal);
  assert.equal(result.contextRevision, 7);
  assert.equal(authorization, `Bearer ${secret}`);
  assert.equal(body.response_format.json_schema.strict, true);
  assert.doesNotMatch(JSON.stringify(gateway.snapshot()), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(gateway.snapshot()), /authorization/i);
});

test('Router Provider failure is returned directly without a fallback decision', async () => {
  const gateway = createRouterAgentGateway({
    config: routerConfig({
      adapter: 'openai-compatible',
      baseUrl: 'https://router.example/v1',
      model: 'router-model',
      apiKeyEnv: 'MISSING_KEY',
      requestTimeoutMs: 5_000,
    }),
    env: {},
    codexClient: { async execute() {}, async close() {} },
    loadProfile: async () => profile(1, 'route'),
    fetch: async () => {
      throw new Error('must not fetch without a credential');
    },
  });
  await assert.rejects(
    gateway.decide(routerRequest(), new AbortController().signal),
    /credential environment variable is unavailable/,
  );
  assert.equal(gateway.snapshot().lastDecisionAt, null);
  assert.match(gateway.snapshot().lastError, /MISSING_KEY/);
});

function routerConfig(providerConfig = {
  adapter: 'codex-app-server',
  lifecycle: 'managed',
  requestTimeoutMs: 5_000,
}) {
  return {
    provider: 'router-provider',
    promptProfile: 'profiles/router/session-routing.json',
    profileRevision: 1,
    profile: { name: 'session-routing', instructions: ['route'] },
    temperature: 0,
    autoSubmitMinConfidence: 0.8,
    autoSubmitMinMargin: 0.1,
    maxTimelineEntries: 12,
    maxCandidates: 6,
    requestTimeoutMs: providerConfig.requestTimeoutMs,
    providerConfig,
  };
}

function profile(version, instruction) {
  return {
    version,
    name: 'session-routing',
    instructions: [instruction],
  };
}

function routerRequest(overrides = {}) {
  const base = {
    message: {
      messageId: 'message-1',
      sequence: 1,
      origin: 'user',
      text: '继续处理先前提到的内容',
      createdAtMs: 1_000,
      references: [],
    },
    visibleContextRevision: 7,
    exposures: [{
      messageId: 'visible-1',
      phase: 'showing',
      visibleText: '任务还在进行',
      complete: false,
      exposureRevision: 3,
    }],
    candidates: [{
      sessionId: 'session-2',
      title: '第二个会话',
      status: 'waiting-input',
      lastVisibleEvent: '等待补充',
    }],
  };
  return {
    ...base,
    ...overrides,
  };
}

function routeResult() {
  return JSON.stringify({
    contextRevision: 7,
    decision: 'route',
    targetKind: 'task-session',
    sessionId: 'session-2',
    confidence: 0.95,
    candidateSessionIds: [],
    candidates: [{ sessionId: 'session-2', score: 0.95, reason: '明确提及第二个会话' }],
  });
}
