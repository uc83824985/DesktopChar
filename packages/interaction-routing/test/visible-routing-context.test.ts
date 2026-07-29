import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VisibleRoutingContext,
  type TaskSessionRouteCandidate,
} from '../src/index.ts';

test('visible routing context freezes a bounded immutable timeline', () => {
  const context = new VisibleRoutingContext({ maxTimelineEntries: 2, maxCandidates: 3 });
  context.recordExposure(exposure('message-1', 'shown', '第一条', 1));
  context.recordExposure(exposure('message-2', 'showing', '第二', 1));
  context.recordExposure(exposure('message-2', 'shown', '第二条', 2));
  context.recordExposure(exposure('message-3', 'shown', '第三条', 1));

  const frozen = context.freeze();
  assert.equal(frozen.visibleContextRevision, 4);
  assert.deepEqual(frozen.exposures.map(item => item.messageId), ['message-2', 'message-3']);
  assert.equal(frozen.exposures[0]?.visibleText, '第二条');
  assert.throws(() => context.recordExposure(
    exposure('message-2', 'showing', '倒退', 3),
  ), /cannot return/);

  (frozen.exposures[0] as { visibleText: string }).visibleText = 'mutated';
  assert.equal(context.freeze().exposures[0]?.visibleText, '第二条');
});

test('candidate LRU changes only for explicit use or a related visible exposure', () => {
  const context = new VisibleRoutingContext({ maxTimelineEntries: 12, maxCandidates: 3 });
  const candidates = [
    candidate('session-a'),
    candidate('session-b'),
    candidate('session-c'),
    candidate('session-d'),
  ];
  context.replaceCandidates(candidates);
  assert.deepEqual(
    context.freeze().candidates.map(item => item.sessionId),
    ['session-a', 'session-b', 'session-c'],
  );

  context.replaceCandidates(candidates.map(item => ({ ...item, status: 'active' })));
  assert.deepEqual(
    context.freeze().candidates.map(item => item.sessionId),
    ['session-a', 'session-b', 'session-c'],
    'background facts do not promote one session in the LRU',
  );

  context.touchSession('session-c');
  context.recordExposure(exposure('task-b', 'shown', 'B 已完成', 1), 'session-b');
  assert.deepEqual(
    context.freeze().candidates.map(item => item.sessionId),
    ['session-b', 'session-c', 'session-a'],
  );
});

test('stale exposure revisions are ignored without changing the frozen revision', () => {
  const context = new VisibleRoutingContext({ maxTimelineEntries: 4, maxCandidates: 2 });
  context.recordExposure(exposure('streaming', 'showing', '正在', 2));
  const revision = context.freeze().visibleContextRevision;
  assert.equal(
    context.recordExposure(exposure('streaming', 'showing', '旧', 1)),
    false,
  );
  assert.equal(context.freeze().visibleContextRevision, revision);
  assert.equal(context.freeze().exposures[0]?.visibleText, '正在');
});

test('visible context limits can be reconfigured for later snapshots', () => {
  const context = new VisibleRoutingContext({ maxTimelineEntries: 3, maxCandidates: 3 });
  context.replaceCandidates([candidate('one'), candidate('two')]);
  context.recordExposure(exposure('first', 'shown', '第一条', 1));
  context.recordExposure(exposure('second', 'shown', '第二条', 1));
  assert.equal(context.freeze().exposures.length, 2);
  context.configure({ maxTimelineEntries: 1, maxCandidates: 1 });
  assert.equal(context.freeze().exposures.length, 1);
  assert.equal(context.freeze().candidates.length, 1);
});

function exposure(
  messageId: string,
  phase: 'showing' | 'shown',
  visibleText: string,
  exposureRevision: number,
) {
  return {
    messageId,
    phase,
    visibleText,
    complete: phase === 'shown',
    exposureRevision,
  } as const;
}

function candidate(sessionId: string): TaskSessionRouteCandidate {
  return {
    sessionId,
    title: `Session ${sessionId}`,
    status: 'waiting-input',
  };
}
