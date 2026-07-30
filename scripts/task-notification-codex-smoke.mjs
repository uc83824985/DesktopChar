import assert from 'node:assert/strict';
import path from 'node:path';
import { compileTaskNotification } from '../packages/interaction-routing/src/index.ts';
import {
  createCodexCharReplyExecutor,
  resolveCodexInvocation,
} from '../apps/desktop/electron/codex-conversation-agent.mjs';

const compiled = compileTaskNotification({
  type: 'task-completed',
  subject: '隔离任务通知验收',
  status: 'completed',
  resultArtifactAvailable: false,
  visibleTextTail: [
    '› 上一轮请求',
    '',
    '• 上一轮结果为蓝色。',
    '',
    '› 本轮请求',
    '',
    '• 本轮任务已完成，最终结果为红色苹果。',
    '',
    '› ',
  ].join('\n'),
});
const executor = createCodexCharReplyExecutor({
  cwd: process.cwd(),
  schemaPath: path.resolve('packages/conversation-runtime/src/codex-reply.schema.json'),
  invocation: resolveCodexInvocation(process.env, {
    launcherScript: process.env.DESKTOP_CHAR_CODEX_LAUNCHER_SCRIPT,
  }),
});

try {
  const result = await executor.execute(
    'char-worker-1',
    task(compiled.focusText),
    new AbortController().signal,
  );
  const reply = result.segments[0]?.text.trim() ?? '';
  assert.match(reply, /红色苹果/u);
  console.log(`Task notification Codex smoke passed: ${reply}`);
}
finally {
  await executor.close();
}

function task(userMessage) {
  return {
    conversationId: 'task-notification-codex-smoke',
    turnId: 'turn-0',
    turnSequence: 0,
    taskId: 'task-0',
    attemptId: 'attempt-0',
    generation: 0,
    deadlineAtMs: Date.now() + 180_000,
    context: {
      schemaVersion: 'desktop-char.char-context.v1',
      baseContextRevision: 1,
      personaRevision: 1,
      persona: {
        name: 'DesktopChar',
        instructions: ['使用简短、自然、适合桌面角色说出的中文回复。'],
      },
      messages: [{
        messageId: 'message-0',
        sequence: 0,
        role: 'user',
        text: userMessage,
        turnId: 'turn-0',
      }],
      focusMessageId: 'message-0',
    },
  };
}
