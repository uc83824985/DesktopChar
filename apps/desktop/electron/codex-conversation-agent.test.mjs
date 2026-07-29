import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexCharReplyExecutor } from './codex-conversation-agent.mjs';

test('Codex conversation executor uses one managed structured-reply client', async () => {
  const calls = [];
  let closed = false;
  const executor = createCodexCharReplyExecutor({
    cwd: process.cwd(),
    schemaPath: 'schema.json',
    outputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    client: {
      async execute(request) {
        calls.push(request);
        return '{"text":"前台回复"}';
      },
      async close() {
        closed = true;
      },
    },
  });
  const result = await executor.execute('codex-a', task(), new AbortController().signal);
  assert.equal(result.segments[0].text, '前台回复');
  assert.equal(result.baseContextRevision, 1);
  assert.equal(result.personaRevision, 2);
  assert.match(calls[0].prompt, /codex-a/);
  assert.equal(calls[0].outputSchema.additionalProperties, false);
  await executor.close();
  assert.equal(closed, true);
});

test('Codex conversation executor rejects untrusted task shapes before spawning', async () => {
  let called = false;
  const executor = createCodexCharReplyExecutor({
    cwd: process.cwd(),
    schemaPath: 'schema.json',
    outputSchema: {},
    client: {
      async execute() {
        called = true;
        return '{"text":"unexpected"}';
      },
      async close() {},
    },
  });
  await assert.rejects(
    executor.execute('codex-a', {
      ...task(),
      context: { ...task().context, messages: [{ role: 'tool' }] },
    }, new AbortController().signal),
    /context\.messages\[0\] is invalid/,
  );
  assert.equal(called, false);
});

test('Codex conversation executor can share a client without closing its owner', async () => {
  let closed = false;
  const executor = createCodexCharReplyExecutor({
    cwd: process.cwd(),
    schemaPath: 'schema.json',
    outputSchema: {},
    ownsClient: false,
    client: {
      async execute() {
        return '{"text":"共享回复"}';
      },
      async close() {
        closed = true;
      },
    },
  });
  await executor.execute('codex-a', task(), new AbortController().signal);
  await executor.close();
  assert.equal(closed, false);
});

function task() {
  return {
    conversationId: 'conversation',
    turnId: 'turn',
    turnSequence: 0,
    taskId: 'task',
    attemptId: 'attempt',
    generation: 0,
    deadlineAtMs: Date.now() + 5_000,
    context: {
      schemaVersion: 'desktop-char.char-context.v1',
      baseContextRevision: 1,
      personaRevision: 2,
      persona: {
        name: '测试角色',
        instructions: ['使用简短自然的中文回复。'],
      },
      messages: [{
        messageId: 'message',
        sequence: 0,
        role: 'user',
        text: '你好',
        turnId: 'turn',
      }],
      focusMessageId: 'message',
    },
  };
}
