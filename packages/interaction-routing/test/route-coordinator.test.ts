import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RouteCoordinator,
  RouteCoordinatorError,
  type InteractionMessage,
  type RouterAgentPort,
  type RouterAgentRequest,
  type RouterAgentResult,
  type RoutingContextSnapshot,
  type TargetSelection,
} from '../src/index.ts';

const config = {
  autoSubmitMinConfidence: 0.85,
  autoSubmitMinMargin: 0.15,
  maxTimelineEntries: 12,
  maxCandidates: 6,
};

test('direct character selection is sticky and never calls Router', async () => {
  const fixture = coordinator({
    initialSelection: { mode: 'direct', target: { kind: 'character' } },
  });
  await fixture.runtime.acceptUserMessage('第一条');
  await fixture.runtime.acceptUserMessage('第二条');
  assert.deepEqual(fixture.characterMessages.map(message => message.text), ['第一条', '第二条']);
  assert.equal(fixture.router.requests.length, 0);
  assert.equal(fixture.runtime.getSnapshot().selection.mode, 'direct');
});

test('direct session selection remains sticky and submits while the session is active', async () => {
  const fixture = coordinator({
    initialSelection: directSession('session-2'),
    context: routeContext(4, [
      candidate('session-2', 'active'),
      candidate('session-1', 'waiting-input'),
    ]),
  });
  await fixture.runtime.acceptUserMessage('补充说明');
  await fixture.runtime.acceptUserMessage('只回复最后请求');
  assert.deepEqual(
    fixture.sessionMessages.map(item => [item.sessionId, item.message.text]),
    [
      ['session-2', '补充说明'],
      ['session-2', '只回复最后请求'],
    ],
  );
  assert.deepEqual(
    fixture.sessionMessages.map(item => item.visibleContextRevision),
    [4, 4],
  );
  assert.equal(fixture.router.requests.length, 0);
});

test('an unavailable sticky session reports an error without changing selection or falling back', async () => {
  const fixture = coordinator({
    initialSelection: directSession('session-2'),
    unavailable: ['session-2'],
  });
  await assert.rejects(
    fixture.runtime.acceptUserMessage('继续'),
    (error: unknown) =>
      error instanceof RouteCoordinatorError && error.code === 'session-unavailable',
  );
  assert.deepEqual(fixture.runtime.getSelection(), directSession('session-2'));
  assert.deepEqual(fixture.characterMessages, []);
  assert.deepEqual(fixture.sessionMessages, []);
  assert.equal(fixture.router.requests.length, 0);
  assert.equal(fixture.runtime.getSnapshot().messages.length, 1);
  assert.equal(fixture.runtime.getSnapshot().routes.length, 0);
});

test('Auto routes to character without a model when no session candidate exists', async () => {
  const fixture = coordinator({ context: routeContext(2, []) });
  const outcome = await fixture.runtime.acceptUserMessage('今天过得怎么样？');
  assert.equal(outcome.record.decision.decision, 'route');
  assert.deepEqual(fixture.characterMessages.map(message => message.text), ['今天过得怎么样？']);
  assert.equal(fixture.router.requests.length, 0);
});

test('Auto submits one clearly leading high-confidence session candidate', async () => {
  const fixture = coordinator({
    routerResults: [routerResult(8, {
      decision: 'route',
      target: { kind: 'task-session', sessionId: 'session-a' },
      confidence: 0.93,
    }, [
      { sessionId: 'session-a', score: 0.94, reason: '当前可见完成事项' },
      { sessionId: 'session-b', score: 0.61, reason: '较早的话题' },
    ])],
  });
  const outcome = await fixture.runtime.acceptUserMessage('继续修改那个项目');
  assert.deepEqual(outcome.record.decision, {
    decision: 'route',
    target: { kind: 'task-session', sessionId: 'session-a' },
    confidence: 0.93,
  });
  assert.deepEqual(fixture.sessionMessages.map(item => item.sessionId), ['session-a']);
  assert.equal(fixture.router.requests[0]?.exposures[0]?.phase, 'showing');
  assert.equal(fixture.router.requests[0]?.exposures[0]?.visibleText, 'A 已完');
});

test('Auto asks for confirmation only when plausible session candidates are close', async () => {
  const fixture = coordinator({
    routerResults: [routerResult(8, {
      decision: 'route',
      target: { kind: 'task-session', sessionId: 'session-a' },
      confidence: 0.88,
    }, [
      { sessionId: 'session-a', score: 0.88, reason: '近期事项' },
      { sessionId: 'session-b', score: 0.82, reason: '也符合继续' },
      { sessionId: 'session-c', score: 0.2, reason: '无明显关系' },
    ])],
  });
  const outcome = await fixture.runtime.acceptUserMessage('继续之前那个');
  assert.deepEqual(outcome.record.decision, {
    decision: 'confirm',
    candidateSessionIds: ['session-a', 'session-b'],
  });
  assert.equal(outcome.dispatched, false);
  assert.deepEqual(fixture.characterMessages, []);
  assert.deepEqual(fixture.sessionMessages, []);
});

test('a confirmed close candidate is revalidated and dispatched once', async () => {
  const fixture = coordinator({
    routerResults: [routerResult(8, {
      decision: 'confirm',
      candidateSessionIds: ['session-a', 'session-b'],
    }, [
      { sessionId: 'session-a', score: 0.83, reason: '近期事项' },
      { sessionId: 'session-b', score: 0.8, reason: '同样合理' },
    ])],
  });
  const outcome = await fixture.runtime.acceptUserMessage('继续');
  const confirmation = await fixture.runtime.confirmPendingRoute(
    outcome.message.messageId,
    'session-b',
    8,
  );
  assert.equal(confirmation.sessionId, 'session-b');
  assert.deepEqual(fixture.sessionMessages.map(item => item.sessionId), ['session-b']);
  assert.equal(fixture.runtime.getSnapshot().pendingConfirmation, undefined);
  await assert.rejects(
    fixture.runtime.confirmPendingRoute(outcome.message.messageId, 'session-b', 8),
    (error: unknown) =>
      error instanceof RouteCoordinatorError && error.code === 'confirmation-missing',
  );
});

test('confirmation refuses a changed visible context and produces no side effect', async () => {
  const mutable = routeContext(8);
  const fixture = coordinator({
    context: mutable,
    routerResults: [routerResult(8, {
      decision: 'confirm',
      candidateSessionIds: ['session-a', 'session-b'],
    }, [
      { sessionId: 'session-a', score: 0.8, reason: '可能相关' },
      { sessionId: 'session-b', score: 0.79, reason: '也可能相关' },
    ])],
  });
  const outcome = await fixture.runtime.acceptUserMessage('继续');
  mutable.visibleContextRevision = 9;
  await assert.rejects(
    fixture.runtime.confirmPendingRoute(outcome.message.messageId, 'session-a', 8),
    (error: unknown) =>
      error instanceof RouteCoordinatorError && error.code === 'confirmation-stale',
  );
  assert.deepEqual(fixture.sessionMessages, []);
});

test('a weak isolated session guess becomes no-match instead of a side effect', async () => {
  const fixture = coordinator({
    routerResults: [routerResult(8, {
      decision: 'route',
      target: { kind: 'task-session', sessionId: 'session-a' },
      confidence: 0.62,
    }, [
      { sessionId: 'session-a', score: 0.62, reason: '弱相关' },
      { sessionId: 'session-b', score: 0.1, reason: '不相关' },
    ])],
  });
  const outcome = await fixture.runtime.acceptUserMessage('这个怎么处理？');
  assert.deepEqual(outcome.record.decision, { decision: 'no-match' });
  assert.equal(outcome.dispatched, false);
  assert.deepEqual(fixture.characterMessages, []);
  assert.deepEqual(fixture.sessionMessages, []);
});

test('Router provider and validation failures never fall back to character or a session', async () => {
  const failed = coordinator({ routerError: new Error('provider offline') });
  await assert.rejects(
    failed.runtime.acceptUserMessage('继续'),
    (error: unknown) =>
      error instanceof RouteCoordinatorError && error.code === 'router-failed',
  );
  assert.deepEqual(failed.characterMessages, []);
  assert.deepEqual(failed.sessionMessages, []);

  const invalid = coordinator({
    routerResults: [routerResult(99, { decision: 'no-match' }, [])],
  });
  await assert.rejects(
    invalid.runtime.acceptUserMessage('继续'),
    (error: unknown) =>
      error instanceof RouteCoordinatorError && error.code === 'router-invalid-result',
  );
  assert.deepEqual(invalid.characterMessages, []);
  assert.deepEqual(invalid.sessionMessages, []);
});

test('Router receives a bounded immutable exposure and candidate snapshot', async () => {
  const mutable = routeContext(8, [
    candidate('session-a'),
    candidate('session-b'),
    candidate('session-c'),
  ]);
  mutable.exposures = Array.from({ length: 15 }, (_, index) => ({
    messageId: `visible-${index}`,
    phase: index === 14 ? 'showing' as const : 'shown' as const,
    visibleText: `text-${index}`,
    complete: index !== 14,
    exposureRevision: index,
  }));
  let resolveResult: ((value: RouterAgentResult) => void) | undefined;
  const deferred = new Promise<RouterAgentResult>(resolve => { resolveResult = resolve; });
  const fixture = coordinator({ context: mutable, routerPromise: deferred });
  const routing = fixture.runtime.acceptUserMessage('继续');
  await waitUntil(() => fixture.router.requests.length === 1);
  mutable.exposures[14]!.visibleText = 'mutated';
  mutable.candidates[0]!.title = 'mutated';
  resolveResult!(routerResult(8, { decision: 'no-match' }, []));
  await routing;
  assert.equal(fixture.router.requests[0]?.exposures.length, 12);
  assert.equal(fixture.router.requests[0]?.exposures.at(-1)?.visibleText, 'text-14');
  assert.equal(fixture.router.requests[0]?.candidates[0]?.title, 'Session session-a');
});

function coordinator(options: {
  initialSelection?: TargetSelection;
  context?: RoutingContextSnapshot;
  routerResults?: RouterAgentResult[];
  routerPromise?: Promise<RouterAgentResult>;
  routerError?: Error;
  unavailable?: string[];
} = {}) {
  const router = new FakeRouter(
    options.routerResults ?? [],
    options.routerPromise,
    options.routerError,
  );
  const currentContext = options.context ?? routeContext(8);
  const characterMessages: InteractionMessage[] = [];
  const sessionMessages: Array<{
    sessionId: string;
    message: InteractionMessage;
    visibleContextRevision: number;
  }> = [];
  const unavailable = new Set(options.unavailable ?? []);
  let id = 0;
  let now = 1_000;
  const runtime = new RouteCoordinator({
    router,
    context: { freeze: () => currentContext },
    character: {
      async submit(message) {
        characterMessages.push(message);
      },
    },
    taskSessions: {
      isAvailable: sessionId => !unavailable.has(sessionId),
      async submit(sessionId, message, visibleContextRevision) {
        sessionMessages.push({ sessionId, message, visibleContextRevision });
      },
    },
    config,
    ...(options.initialSelection ? { initialSelection: options.initialSelection } : {}),
    idFactory: () => `interaction-${id++}`,
    now: () => now++,
  });
  return { runtime, router, characterMessages, sessionMessages };
}

class FakeRouter implements RouterAgentPort {
  readonly requests: RouterAgentRequest[] = [];
  private readonly results: RouterAgentResult[];
  private readonly promisedResult: Promise<RouterAgentResult> | undefined;
  private readonly error: Error | undefined;

  constructor(
    results: RouterAgentResult[],
    promisedResult?: Promise<RouterAgentResult>,
    error?: Error,
  ) {
    this.results = results;
    this.promisedResult = promisedResult;
    this.error = error;
  }

  async decide(request: RouterAgentRequest): Promise<RouterAgentResult> {
    this.requests.push(structuredClone(request));
    if (this.error) throw this.error;
    if (this.promisedResult) return this.promisedResult;
    const result = this.results.shift();
    if (!result) throw new Error('Fake Router has no result');
    return result;
  }
}

function routeContext(
  visibleContextRevision: number,
  candidates = [
    candidate('session-a'),
    candidate('session-b'),
    candidate('session-c'),
  ],
): RoutingContextSnapshot {
  return {
    visibleContextRevision,
    exposures: [{
      messageId: 'visible-a',
      phase: 'showing',
      visibleText: 'A 已完',
      complete: false,
      exposureRevision: 7,
    }],
    candidates,
  };
}

function candidate(
  sessionId: string,
  status: 'waiting-input' | 'active' | 'idle-unknown' | 'unavailable' = 'waiting-input',
) {
  return {
    sessionId,
    title: `Session ${sessionId}`,
    summary: '有界任务摘要',
    status,
    lastVisibleEvent: `${sessionId} 最近可见`,
  };
}

function routerResult(
  contextRevision: number,
  route: RouterAgentResult['route'],
  candidates: RouterAgentResult['candidates'],
): RouterAgentResult {
  return { contextRevision, route, candidates };
}

function directSession(sessionId: string): TargetSelection {
  return { mode: 'direct', target: { kind: 'task-session', sessionId } };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Condition was not reached');
}
