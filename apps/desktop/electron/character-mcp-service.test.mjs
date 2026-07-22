import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CHARACTER_MCP_TOOLS, createCharacterMcpService } from './character-mcp-service.mjs';

test('character MCP exposes state, capabilities, performance and interrupt through the official client', async t => {
  const commands = [];
  const service = createCharacterMcpService({ port: 0, onCommand: command => commands.push(command) });
  service.updateState({ ready: true, snapshot: { state: 'idle', capabilities: { emotions: ['happy'], actions: ['nod'] } } });
  const address = await service.listen();
  t.after(() => service.close());
  const client = new Client({ name: 'character-mcp-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(address.mcpUrl)));
  t.after(() => client.close());

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [...CHARACTER_MCP_TOOLS].sort());
  const state = await client.callTool({ name: 'desktop_char_get_state', arguments: {} });
  assert.equal(JSON.parse(state.content[0].text).snapshot.state, 'idle');
  const capabilities = await client.callTool({ name: 'desktop_char_get_capabilities', arguments: {} });
  assert.deepEqual(JSON.parse(capabilities.content[0].text).avatar.actions, ['nod']);

  const plan = {
    id: 'mcp-plan',
    segments: [{ id: 'mcp-segment', sequence: 0, displayText: '你好', speechText: '你好' }],
  };
  const performed = await client.callTool({ name: 'desktop_char_perform', arguments: { plan } });
  assert.deepEqual(performed.structuredContent, { accepted: true, plan_id: 'mcp-plan' });
  const interrupted = await client.callTool({ name: 'desktop_char_interrupt', arguments: {} });
  assert.deepEqual(interrupted.structuredContent, { accepted: true });
  assert.deepEqual(commands, [
    { type: 'performance.submit', plan },
    { type: 'performance.interrupt' },
  ]);
});

test('character MCP enforces loopback binding and Runtime readiness', async t => {
  assert.throws(() => createCharacterMcpService({ host: '0.0.0.0' }), /loopback/);
  const service = createCharacterMcpService({ port: 0 });
  const address = await service.listen();
  t.after(() => service.close());
  const client = new Client({ name: 'character-mcp-not-ready-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(address.mcpUrl)));
  t.after(() => client.close());
  const result = await client.callTool({
    name: 'desktop_char_perform',
    arguments: { plan: { id: 'p', segments: [{ id: 's', sequence: 0, displayText: 'x', speechText: 'x' }] } },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /avatar-not-ready/);
});
