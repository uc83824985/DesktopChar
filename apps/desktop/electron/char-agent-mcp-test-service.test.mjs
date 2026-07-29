import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CHAR_AGENT_MCP_TEST_TOOL,
  createCharAgentMcpTestService,
} from './char-agent-mcp-test-service.mjs';

test('Char Agent MCP test adapter maps one UTF-8 task through the official client', async t => {
  const calls = [];
  const service = createCharAgentMcpTestService({
    endpoint: {
      async execute(task, signal) {
        assert.equal(signal.aborted, false);
        calls.push(task);
        return {
          conversationId: task.conversationId,
          turnId: task.turnId,
          taskId: task.taskId,
          attemptId: task.attemptId,
          generation: task.generation,
          baseContextRevision: task.context.baseContextRevision,
          personaRevision: task.context.personaRevision,
          segments: [{ segmentId: 'segment-1', text: '你好，契约测试成功。' }],
        };
      },
    },
  });
  const address = await service.listen();
  t.after(() => service.close());
  const client = new Client({ name: 'char-agent-mcp-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(address.mcpUrl)));
  t.after(() => client.close());

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name), [CHAR_AGENT_MCP_TEST_TOOL]);
  const task = charTask();
  const response = await client.callTool({
    name: CHAR_AGENT_MCP_TEST_TOOL,
    arguments: { task },
  });
  assert.equal(response.structuredContent.segments[0].text, '你好，契约测试成功。');
  assert.equal(calls[0].context.messages[0].text, '测试 UTF-8：你好。');
});

test('Char Agent MCP test adapter rejects an invalid focus message before endpoint execution', async t => {
  let called = false;
  const service = createCharAgentMcpTestService({
    endpoint: {
      async execute() {
        called = true;
        throw new Error('unexpected');
      },
    },
  });
  const address = await service.listen();
  t.after(() => service.close());
  const client = new Client({ name: 'char-agent-mcp-invalid-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(address.mcpUrl)));
  t.after(() => client.close());

  const response = await client.callTool({
    name: CHAR_AGENT_MCP_TEST_TOOL,
    arguments: {
      task: {
        ...charTask(),
        context: { ...charTask().context, focusMessageId: 'missing' },
      },
    },
  });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /focusMessageId/);
  assert.equal(called, false);
});

function charTask() {
  return {
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    turnSequence: 0,
    taskId: 'task-1',
    attemptId: 'attempt-1',
    generation: 0,
    deadlineAtMs: Date.now() + 5_000,
    context: {
      schemaVersion: 'desktop-char.char-context.v1',
      baseContextRevision: 1,
      personaRevision: 1,
      persona: {
        name: '测试角色',
        instructions: ['使用简短中文回复。'],
      },
      messages: [{
        messageId: 'message-1',
        sequence: 0,
        role: 'user',
        text: '测试 UTF-8：你好。',
        turnId: 'turn-1',
      }],
      focusMessageId: 'message-1',
    },
  };
}
