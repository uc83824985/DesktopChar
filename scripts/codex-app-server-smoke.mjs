import assert from 'node:assert/strict';
import path from 'node:path';
import { createCodexConversationReplyExecutor } from '../apps/desktop/electron/codex-conversation-agent.mjs';

const executor = createCodexConversationReplyExecutor({
  cwd: process.cwd(),
  schemaPath: path.resolve('packages/conversation-runtime/src/codex-reply.schema.json'),
});

try {
  const results = await Promise.all([
    executor.execute('assistant-1', task(0, '请只回复：助手一就绪'), new AbortController().signal),
    executor.execute('assistant-2', task(1, '请只回复：助手二就绪'), new AbortController().signal),
  ]);
  assert.equal(results.length, 2);
  assert.equal(results.every(result => result.segments[0]?.text.trim()), true);
  console.log('Codex app-server smoke passed with one managed process and two concurrent threads.');
  console.log(results.map(result => result.segments[0].text));
}
finally {
  await executor.close();
}

function task(sequence, userMessage) {
  const turnId = `turn-${sequence}`;
  return {
    conversationId: 'app-server-smoke',
    turnId,
    turnSequence: sequence,
    taskId: `task-${sequence}`,
    attemptId: `attempt-${sequence}`,
    generation: 0,
    baseContextRevision: sequence + 1,
    messages: [{
      messageId: `message-${sequence}`,
      sequence,
      role: 'user',
      text: userMessage,
      turnId,
    }],
    userMessage,
  };
}
