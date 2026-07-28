import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationReplyGateway } from './conversation-reply-gateway.mjs';

test('reply gateway owns one managed App Server executor and audits logical replies', async () => {
  let managedCreated = 0;
  let managedClosed = 0;
  const gateway = createConversationReplyGateway({
    config: config(),
    createManagedExecutor(timeoutMs) {
      managedCreated++;
      assert.equal(timeoutMs, 5_000);
      return {
        async execute(_agentId, value) {
          return reply(value, `托管回复 ${value.turnSequence}`);
        },
        async close() {
          managedClosed++;
        },
      };
    },
  });

  assert.equal(
    (await gateway.execute('assistant-1', task(0), new AbortController().signal)).segments[0].text,
    '托管回复 0',
  );
  assert.equal(
    (await gateway.execute('assistant-2', task(1), new AbortController().signal)).segments[0].text,
    '托管回复 1',
  );
  const snapshot = gateway.snapshot();
  assert.equal(snapshot.managed.phase, 'ready');
  assert.equal(snapshot.managed.active, 0);
  assert.equal(managedCreated, 1);
  assert.deepEqual(snapshot.activities.map(activity => [activity.providerKind, activity.input, activity.reply]), [
    ['managed', '消息 0', '托管回复 0'],
    ['managed', '消息 1', '托管回复 1'],
  ]);
  await gateway.close();
  assert.equal(managedClosed, 1);
});

function config() {
  return {
    maxAssistants: 2,
    reply: {
      requestTimeoutMs: 5_000,
    },
  };
}

function task(sequence) {
  return {
    conversationId: 'conversation',
    turnId: `turn-${sequence}`,
    turnSequence: sequence,
    taskId: `task-${sequence}`,
    attemptId: `attempt-${sequence}`,
    generation: 0,
    baseContextRevision: sequence + 1,
    messages: [],
    userMessage: `消息 ${sequence}`,
  };
}

function reply(value, text) {
  return {
    conversationId: value.conversationId,
    turnId: value.turnId,
    taskId: value.taskId,
    attemptId: value.attemptId,
    generation: value.generation,
    segments: [{ segmentId: `segment-${value.turnId}`, text }],
  };
}
