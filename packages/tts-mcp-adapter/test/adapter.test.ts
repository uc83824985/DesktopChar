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

test('mock adapter prepares a deterministic 24kHz PCM stream by default', async () => {
  const logger = new InMemoryTtsLogger();
  const adapter = new MockTtsAdapter({ delayMs: 0, durationPerCharacterMs: 100, minimumDurationMs: 300, amplitudeIntervalMs: 100, logger });
  const audio = await adapter.prepare({ requestId: 'r1', text: '测试', delivery: 'stream-required' });
  assert.deepEqual({ delivery: audio.delivery, requestId: audio.requestId, mimeType: audio.mimeType }, { delivery: 'stream', requestId: 'r1', mimeType: 'audio/pcm' });
  if (audio.delivery !== 'stream') assert.fail('expected stream');
  assert.equal(audio.codec, 'pcm_s16le');
  assert.equal(audio.sampleRateHz, 24_000);
  assert.equal(audio.channels, 1);
  assert.equal(audio.durationMs, 300);
  assert.deepEqual(audio.amplitude?.map(sample => sample.atMs), [0, 100, 200, 300]);
  assert.equal((await adapter.health()).status, 'ready');
  assert.equal((await adapter.capabilities()).streaming, true);
  assert.deepEqual(logger.entries.map(entry => entry.event), ['tts.prepare.started', 'tts.source.ready']);
});

test('mock adapter preserves artifact fallback, configured failures, and cancellation', async () => {
  const artifact = await new MockTtsAdapter({ delayMs: 0 }).prepare({ requestId: 'artifact', text: 'hello', delivery: 'artifact' });
  assert.equal(artifact.delivery, 'artifact');
  assert.equal(artifact.mimeType, 'audio/wav');

  const failing = new MockTtsAdapter({ delayMs: 0, failPattern: /FAIL/ });
  await assert.rejects(failing.prepare({ requestId: 'fail', text: 'FAIL' }), error => error instanceof TtsAdapterError && error.code === 'tts-mock-failure');
  const controller = new AbortController();
  const delayed = new MockTtsAdapter({ delayMs: 1_000 }).prepare({ requestId: 'cancel', text: 'cancel', signal: controller.signal });
  controller.abort();
  await assert.rejects(delayed, error => error instanceof TtsAdapterError && error.code === 'tts-aborted');

  const artifactOnly = new MockTtsAdapter({ delayMs: 0, delivery: 'artifact' });
  assert.equal((await artifactOnly.capabilities()).streaming, false);
  await assert.rejects(
    artifactOnly.prepare({ requestId: 'strict', text: 'hello', delivery: 'stream-required' }),
    error => error instanceof TtsAdapterError && error.code === 'tts-stream-unavailable',
  );
});

test('MCP adapter maps streaming arguments and normalizes snake-case PCM descriptors', async () => {
  const client = new VirtualMcpClient([{ name: 'tts_open_stream', outputSchema: { type: 'object' } }], () => ({
    content: [],
    structuredContent: { stream: {
      request_id: 'r-stream', stream_url: 'http://127.0.0.1/audio/r-stream', delivery: 'stream',
      mime_type: 'audio/pcm', codec: 'pcm_s16le', sample_rate_hz: 24000, channels: 1,
      amplitude: [{ at_ms: 100, value: 2 }, { at_ms: 0, value: -1 }],
    } },
  }));
  const adapter = new McpTtsAdapter({ client, timeoutMs: 500 });
  const audio = await adapter.prepare({ requestId: 'r-stream', text: ' hello ', delivery: 'stream-required', voice: 'alice', language: 'Chinese', instruction: '温和', format: 'pcm_s16le' });
  assert.deepEqual(client.calls[0], { name: 'tts_open_stream', args: {
    request_id: 'r-stream', text: 'hello', delivery: 'stream-required', voice: 'alice', language: 'Chinese', instruction: '温和', format: 'pcm_s16le',
  } });
  assert.equal(audio.delivery, 'stream');
  if (audio.delivery !== 'stream') assert.fail('expected stream');
  assert.equal(audio.sampleRateHz, 24_000);
  assert.deepEqual(audio.amplitude, [{ atMs: 0, value: 0 }, { atMs: 100, value: 1 }]);
  assert.equal((await adapter.health()).status, 'ready');
});

test('MCP health is degraded when a tool has no output schema', async () => {
  const client = new VirtualMcpClient([{ name: 'tts_open_stream' }], () => ({ content: [] }));
  assert.equal((await new McpTtsAdapter({ client }).health()).status, 'degraded');
});

test('MCP adapter retains standard audio block and text JSON artifact compatibility', async () => {
  const audioClient = new VirtualMcpClient([], () => ({ content: [{ type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav' }] }));
  const audio = await new McpTtsAdapter({ client: audioClient }).prepare({ requestId: 'a', text: 'a', delivery: 'artifact' });
  assert.equal(audio.delivery, 'artifact');
  assert.equal(audio.uri, 'data:audio/wav;base64,UklGRg==');

  const textClient = new VirtualMcpClient([], () => ({ content: [{ type: 'text', text: JSON.stringify({ uri: 'http://localhost/a.wav', duration_ms: 100 }) }] }));
  const text = await new McpTtsAdapter({ client: textClient }).prepare({ requestId: 'b', text: 'b', delivery: 'artifact' });
  assert.equal(text.durationMs, 100);
});

test('stream-required requests reject artifact fallback', async () => {
  const client = new VirtualMcpClient([], () => ({ content: [{ type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav' }] }));
  await assert.rejects(
    new McpTtsAdapter({ client }).prepare({ requestId: 'strict', text: 'a', delivery: 'stream-required' }),
    error => error instanceof TtsAdapterError && error.code === 'tts-stream-unavailable',
  );
});

test('MCP adapter rejects a stream belonging to another request', async () => {
  const client = new VirtualMcpClient([], () => ({
    content: [],
    structuredContent: { stream: {
      request_id: 'other', stream_url: 'http://127.0.0.1/audio/other',
      delivery: 'stream', codec: 'pcm_s16le', sample_rate_hz: 24000, channels: 1,
    } },
  }));
  await assert.rejects(
    new McpTtsAdapter({ client }).prepare({ requestId: 'expected', text: 'a', delivery: 'stream-required' }),
    error => error instanceof TtsAdapterError && error.code === 'tts-request-mismatch',
  );
});

test('MCP adapter distinguishes tool failures, malformed payloads, timeout, and cancellation', async () => {
  const toolFailure = new McpTtsAdapter({ client: new VirtualMcpClient([], () => ({ isError: true, content: [{ type: 'text', text: 'voice missing' }] })) });
  await assert.rejects(toolFailure.prepare({ requestId: 'e1', text: 'a' }), error => error instanceof TtsAdapterError && error.code === 'tts-mcp-tool-error');

  const malformed = new McpTtsAdapter({ client: new VirtualMcpClient([], () => ({ content: [{ type: 'text', text: '{}' }] })) });
  await assert.rejects(malformed.prepare({ requestId: 'e2', text: 'a' }), error => error instanceof TtsAdapterError && error.code === 'tts-mcp-invalid-response');

  const timeout = new McpTtsAdapter({ timeoutMs: 10, client: new VirtualMcpClient([], () => new Promise(() => undefined)) });
  await assert.rejects(timeout.prepare({ requestId: 'e3', text: 'a' }), error => error instanceof TtsAdapterError && error.code === 'tts-timeout');

  const cancelClient = new VirtualMcpClient([], () => ({ content: [] }));
  await new McpTtsAdapter({ client: cancelClient }).cancel('r-cancel');
  assert.deepEqual(cancelClient.calls[0], { name: 'tts_cancel_synthesis', args: { request_id: 'r-cancel' } });
});

test('runtime effect handler requests a stream source and emits Runtime facts', async () => {
  const adapter = new MockTtsAdapter({ delayMs: 0 });
  const handler = new TtsRuntimeEffectHandler(adapter);
  const events: AvatarEvent[] = [];
  const effect: RuntimeEffect = { type: 'tts.synthesize', generation: 3, segment: { id: 's1', sequence: 0, displayText: 'hi', speechText: 'hi' } };
  assert.equal(handler.handle(effect, event => events.push(event)), true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events[0]?.type, 'tts.segment-ready');
  if (events[0]?.type !== 'tts.segment-ready') assert.fail('expected ready');
  assert.equal(events[0].audio.delivery, 'stream');
  assert.equal(events[0].audio.requestId, 'g3:s1');
  assert.equal(handler.handle({ type: 'tts.cancel', generation: 3 }, event => events.push(event)), true);
  assert.equal(handler.handle({ type: 'audio.stop', generation: 3 }, event => events.push(event)), false);
});
