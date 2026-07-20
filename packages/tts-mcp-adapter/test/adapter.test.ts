import assert from 'node:assert/strict';
import test from 'node:test';
import type { AvatarEvent, RuntimeEffect } from '../../contracts/src/index.ts';
import {
  InMemoryTtsLogger,
  McpTtsAdapter,
  MockTtsAdapter,
  TtsAdapterError,
  TtsRuntimeEffectHandler,
  VirtualMcpClient,
} from '../src/index.ts';

test('mock adapter returns deterministic timing, amplitude, health, and structured logs', async () => {
  const logger = new InMemoryTtsLogger();
  const adapter = new MockTtsAdapter({ delayMs: 0, durationPerCharacterMs: 100, minimumDurationMs: 300, amplitudeIntervalMs: 100, logger });
  const audio = await adapter.synthesize({ text: '测试' });
  assert.match(audio.uri, /^mock:\/\/tts\/mock-1$/);
  assert.equal(audio.durationMs, 300);
  assert.deepEqual(audio.amplitude?.map(sample => sample.atMs), [0, 100, 200, 300]);
  assert.equal((await adapter.health()).status, 'ready');
  assert.equal((await adapter.capabilities()).supportsAmplitude, true);
  assert.deepEqual(logger.entries.map(entry => entry.event), ['tts.synthesis.started', 'tts.synthesis.completed']);
});

test('mock adapter reports configured failures and cancellation', async () => {
  const failing = new MockTtsAdapter({ delayMs: 0, failPattern: /FAIL/ });
  await assert.rejects(failing.synthesize({ text: 'FAIL' }), error => error instanceof TtsAdapterError && error.code === 'tts-mock-failure');
  const controller = new AbortController();
  const delayed = new MockTtsAdapter({ delayMs: 1_000 }).synthesize({ text: 'cancel', signal: controller.signal });
  controller.abort();
  await assert.rejects(delayed, error => error instanceof TtsAdapterError && error.code === 'tts-aborted');
});

test('MCP adapter maps arguments and normalizes structured audio metadata', async () => {
  const client = new VirtualMcpClient([{ name: 'speak' }], call => ({
    content: [],
    structuredContent: { audio: {
      uri: 'memory://voice.wav', durationMs: 900,
      visemes: [{ atMs: 200, durationMs: 50, viseme: 'A', weight: 2 }, { atMs: 0, durationMs: 40, viseme: 'sil' }],
      amplitude: [{ atMs: 100, value: 2 }, { atMs: 0, value: -1 }],
    } },
  }));
  const adapter = new McpTtsAdapter({ client, toolName: 'speak', textArgument: 'input', timeoutMs: 500, supportsVisemes: true, supportsAmplitude: true });
  const audio = await adapter.synthesize({ text: ' hello ', voice: 'alice', rate: 1.2, format: 'wav' });
  assert.deepEqual(client.calls[0], { name: 'speak', args: { input: 'hello', voice: 'alice', rate: 1.2, format: 'wav' } });
  assert.equal(audio.uri, 'memory://voice.wav');
  assert.deepEqual(audio.visemes?.map(item => [item.atMs, item.weight]), [[0, undefined], [200, 1]]);
  assert.deepEqual(audio.amplitude, [{ atMs: 0, value: 0 }, { atMs: 100, value: 1 }]);
  assert.equal((await adapter.health()).status, 'ready');
});

test('MCP adapter accepts standard audio blocks and text JSON fallback', async () => {
  const audioClient = new VirtualMcpClient([{ name: 'tts.synthesize' }], () => ({ content: [{ type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav' }] }));
  const audio = await new McpTtsAdapter({ client: audioClient }).synthesize({ text: 'a' });
  assert.equal(audio.uri, 'data:audio/wav;base64,UklGRg==');

  const textClient = new VirtualMcpClient([{ name: 'tts.synthesize' }], () => ({ content: [{ type: 'text', text: JSON.stringify({ uri: 'file:///tmp/a.wav', durationMs: 100 }) }] }));
  const text = await new McpTtsAdapter({ client: textClient }).synthesize({ text: 'b' });
  assert.equal(text.durationMs, 100);
});

test('MCP adapter distinguishes missing tools, tool failures, malformed payloads, and timeout', async () => {
  const missing = new McpTtsAdapter({ client: new VirtualMcpClient([], () => ({ content: [] })) });
  assert.equal((await missing.health()).status, 'unavailable');

  const toolFailure = new McpTtsAdapter({ client: new VirtualMcpClient([{ name: 'tts.synthesize' }], () => ({ isError: true, content: [{ type: 'text', text: 'voice missing' }] })) });
  await assert.rejects(toolFailure.synthesize({ text: 'a' }), error => error instanceof TtsAdapterError && error.code === 'tts-mcp-tool-error');

  const malformed = new McpTtsAdapter({ client: new VirtualMcpClient([{ name: 'tts.synthesize' }], () => ({ content: [{ type: 'text', text: '{}' }] })) });
  await assert.rejects(malformed.synthesize({ text: 'a' }), error => error instanceof TtsAdapterError && error.code === 'tts-mcp-invalid-response');

  const timeout = new McpTtsAdapter({ timeoutMs: 10, client: new VirtualMcpClient([{ name: 'tts.synthesize' }], () => new Promise(() => undefined)) });
  await assert.rejects(timeout.synthesize({ text: 'a' }), error => error instanceof TtsAdapterError && error.code === 'tts-timeout');
});

test('runtime effect handler translates synthesis and cancellation into Runtime facts', async () => {
  const adapter = new MockTtsAdapter({ delayMs: 0 });
  const handler = new TtsRuntimeEffectHandler(adapter);
  const events: AvatarEvent[] = [];
  const effect: RuntimeEffect = { type: 'tts.synthesize', generation: 3, segment: { id: 's1', sequence: 0, displayText: 'hi', speechText: 'hi' } };
  assert.equal(handler.handle(effect, event => events.push(event)), true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events[0]?.type, 'tts.segment-ready');
  assert.equal(handler.handle({ type: 'tts.cancel', generation: 3 }, event => events.push(event)), true);
  assert.equal(handler.handle({ type: 'audio.stop', generation: 3 }, event => events.push(event)), false);
});
