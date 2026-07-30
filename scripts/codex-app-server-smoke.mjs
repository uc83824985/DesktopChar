import assert from 'node:assert/strict';
import path from 'node:path';
import {
  createCodexCharReplyExecutor,
  resolveCodexInvocation,
} from '../apps/desktop/electron/codex-conversation-agent.mjs';

const executor = createCodexCharReplyExecutor({
  cwd: process.cwd(),
  schemaPath: path.resolve('packages/conversation-runtime/src/codex-reply.schema.json'),
  invocation: resolveCodexInvocation(process.env, {
    launcherScript: process.env.DESKTOP_CHAR_CODEX_LAUNCHER_SCRIPT,
  }),
});

try {
  const results = await Promise.all([
    executor.execute('char-worker-1', task(0, '请只回复：角色工作线程一就绪'), new AbortController().signal),
    executor.execute('char-worker-2', task(1, '请只回复：角色工作线程二就绪'), new AbortController().signal),
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
  const messageId = `message-${sequence}`;
  return {
    conversationId: 'app-server-smoke',
    turnId,
    turnSequence: sequence,
    taskId: `task-${sequence}`,
    attemptId: `attempt-${sequence}`,
    generation: 0,
    deadlineAtMs: Date.now() + 180_000,
    context: {
      schemaVersion: 'desktop-char.char-context.v1',
      baseContextRevision: sequence + 1,
      personaRevision: 1,
      persona: {
        name: 'DesktopChar',
        instructions: ['使用简短、自然、适合桌面角色说出的中文回复。'],
      },
      messages: [{
        messageId,
        sequence,
        role: 'user',
        text: userMessage,
        turnId,
      }],
      focusMessageId: messageId,
    },
  };
}
