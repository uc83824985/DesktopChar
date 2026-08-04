import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationReplyGateway } from './conversation-reply-gateway.mjs';

test('reply gateway owns one managed App Server executor and logs logical reply stages', async () => {
  let managedCreated = 0;
  let managedClosed = 0;
  const gateway = createConversationReplyGateway({
    config: config(),
    createManagedExecutor(timeoutMs) {
      managedCreated++;
      assert.equal(timeoutMs, 5_000);
      return {
        async execute(_agentId, value, _signal, onDiagnostic) {
          onDiagnostic({ stage: 'prompt-prepared', at: '2026-08-04T00:00:00Z', detail: 'focusIncluded=true' });
          onDiagnostic({ stage: 'thread-started', at: '2026-08-04T00:00:01Z', detail: `thread-${value.turnSequence}` });
          return reply(value, `托管回复 ${value.turnSequence}`);
        },
        async close() {
          managedClosed++;
        },
      };
    },
  });

  assert.equal(
    (await gateway.execute('char-worker-1', task(0), new AbortController().signal)).segments[0].text,
    '托管回复 0',
  );
  assert.equal(
    (await gateway.execute('char-worker-2', task(1), new AbortController().signal)).segments[0].text,
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
  assert.deepEqual(snapshot.activities[0].diagnostics.map(item => item.stage), [
    'task-received',
    'prompt-prepared',
    'thread-started',
  ]);
  assert.match(snapshot.activities[0].diagnostics[0].detail, /"focusMessageId":"message-0"/);
  assert.equal(snapshot.activities[0].diagnostics[2].detail, 'thread-0');
  await gateway.close();
  assert.equal(managedClosed, 1);
});

function config() {
  return {
    maxConcurrency: 2,
    requestTimeoutMs: 5_000,
  };
}

function task(sequence) {
  const messageId = `message-${sequence}`;
  return {
    conversationId: 'conversation',
    turnId: `turn-${sequence}`,
    turnSequence: sequence,
    taskId: `task-${sequence}`,
    attemptId: `attempt-${sequence}`,
    generation: 0,
    deadlineAtMs: Date.now() + 5_000,
    context: {
      schemaVersion: 'desktop-char.char-context.v1',
      baseContextRevision: sequence + 1,
      personaRevision: 1,
      persona: { name: '测试角色', instructions: [] },
      messages: [{
        messageId,
        sequence,
        role: 'user',
        text: `消息 ${sequence}`,
        turnId: `turn-${sequence}`,
      }],
      focusMessageId: messageId,
    },
  };
}

function reply(value, text) {
  return {
    conversationId: value.conversationId,
    turnId: value.turnId,
    taskId: value.taskId,
    attemptId: value.attemptId,
    generation: value.generation,
    baseContextRevision: value.context.baseContextRevision,
    personaRevision: value.context.personaRevision,
    segments: [{ segmentId: `segment-${value.turnId}`, text }],
  };
}
