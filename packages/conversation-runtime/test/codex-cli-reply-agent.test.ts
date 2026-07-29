import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CodexCliCharAgent,
  createCharReplyPrompt,
  type CodexProcessRunner,
  type CharReplyTask,
} from '../src/index.ts';

test('Codex CLI test agent uses ephemeral read-only structured exec', async () => {
  const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const runner: CodexProcessRunner = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    return { exitCode: 0, stdout: '{"text":"测试回复"}\n', stderr: 'progress' };
  };
  const agent = new CodexCliCharAgent({
    cwd: 'C:\\workspace',
    command: 'codex-test',
    commandArgs: ['cli-entry.js'],
    schemaPath: 'C:\\schema.json',
    processRunner: runner,
  });
  const task = replyTask();
  const result = await agent.execute(task, new AbortController().signal);

  assert.equal(result.segments[0]?.text, '测试回复');
  assert.equal(calls[0]?.command, 'codex-test');
  assert.equal(calls[0]?.args[0], 'cli-entry.js');
  assert.equal(calls[0]?.cwd, 'C:\\workspace');
  assert.ok(calls[0]?.args.includes('exec'));
  assert.ok(calls[0]?.args.includes('--ephemeral'));
  assert.ok(calls[0]?.args.includes('read-only'));
  assert.ok(calls[0]?.args.includes('--ignore-user-config'));
  assert.ok(calls[0]?.args.includes('--output-schema'));
  assert.match(calls[0]?.args.at(-1) ?? '', /纯文本 Char 测试 Agent/);
});

test('Codex CLI test prompt treats conversation messages as data', () => {
  const prompt = createCharReplyPrompt(replyTask());
  assert.match(prompt, /只读对话数据/);
  assert.match(prompt, /不要调用工具/);
  assert.match(prompt, /"userMessage":"你好"/);
});

function replyTask(): CharReplyTask {
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
