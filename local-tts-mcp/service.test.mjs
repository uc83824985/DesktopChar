import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLocalTtsMcpService } from './service.mjs';

test('official MCP client opens a real single-use HTTP PCM stream', async t => {
  const fixture = await startFixture(t, { delayMs: 0, chunkDelayMs: 0 });
  const tools = await fixture.client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name), ['tts_open_stream', 'tts_cancel_synthesis']);
  assert.ok(tools.tools.every(tool => tool.inputSchema && tool.outputSchema));
  assert.deepEqual(tools.tools[0].inputSchema.properties.voice.enum, ['jrpg-blip', 'jrpg-blip-varied']);

  const result = await fixture.client.callTool({
    name: 'tts_open_stream',
    arguments: { request_id: 'contract', text: 'hello', delivery: 'stream-required', format: 'pcm_s16le' },
  });
  const stream = result.structuredContent?.stream;
  assert.deepEqual({
    requestId: stream?.request_id,
    delivery: stream?.delivery,
    codec: stream?.codec,
    sampleRateHz: stream?.sample_rate_hz,
    channels: stream?.channels,
    durationMs: stream?.duration_ms,
  }, {
    requestId: 'contract', delivery: 'stream', codec: 'pcm_s16le',
    sampleRateHz: 24_000, channels: 1, durationMs: 1_315,
  });
  assert.equal(stream.text_cues.map(cue => cue.text).join(''), 'hello');
  assert.equal(stream.text_cues.length, 5);
  const response = await fetch(stream.stream_url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/pcm');
  assert.equal(response.headers.get('content-length'), null, 'the data plane must remain chunked');
  const pcm = new Uint8Array(await response.arrayBuffer());
  assert.equal(pcm.byteLength, Math.round(stream.duration_ms * 24_000 / 1_000) * 2);
  assert.ok(pcm.some(byte => byte !== 0));
  assert.equal(fixture.service.diagnostics().streams, 0);
});

test('reference MCP exposes fixed and deterministic varied blip voices with Chinese punctuation cues', async t => {
  const fixture = await startFixture(t, { delayMs: 0, chunkDelayMs: 0 });
  const accepted = await fixture.client.callTool({
    name: 'tts_open_stream',
    arguments: {
      request_id: 'jrpg-cues', text: '你，好。', voice: 'jrpg-blip',
      delivery: 'stream-required', format: 'pcm_s16le',
    },
  });
  const stream = accepted.structuredContent.stream;
  assert.equal(stream.text_cues.map(cue => cue.text).join(''), '你，好。');
  assert.equal(stream.text_cues[1].duration_ms - stream.text_cues[0].duration_ms, 160);
  assert.equal(stream.text_cues[3].duration_ms - stream.text_cues[2].duration_ms, 260);
  const response = await fetch(stream.stream_url);
  await response.arrayBuffer();

  const varied = await fixture.client.callTool({
    name: 'tts_open_stream',
    arguments: {
      request_id: 'jrpg-varied', text: '你，好。', voice: 'jrpg-blip-varied',
      delivery: 'stream-required', format: 'pcm_s16le',
    },
  });
  assert.equal(varied.isError, undefined);
  assert.equal(varied.structuredContent.stream.duration_ms, stream.duration_ms);
  await (await fetch(varied.structuredContent.stream.stream_url)).arrayBuffer();

  const rejected = await fixture.client.callTool({
    name: 'tts_open_stream',
    arguments: {
      request_id: 'unsupported-voice', text: 'hello', voice: 'other',
      delivery: 'stream-required', format: 'pcm_s16le',
    },
  });
  assert.equal(rejected.isError, true);
});

test('service default rate is configurable and an explicit MCP rate overrides it', async t => {
  const fixture = await startFixture(t, { delayMs: 0, chunkDelayMs: 0, defaultRate: 0.5 });
  assert.deepEqual(
    { voice: fixture.service.diagnostics().voice, defaultRate: fixture.service.diagnostics().defaultRate },
    { voice: 'jrpg-blip', defaultRate: 0.5 },
  );
  const defaulted = await fixture.client.callTool({
    name: 'tts_open_stream',
    arguments: { request_id: 'slow-default', text: 'hello', delivery: 'stream-required', format: 'pcm_s16le' },
  });
  assert.equal(defaulted.structuredContent.stream.requested_rate, 0.5);
  assert.equal(defaulted.structuredContent.stream.duration_ms, 2_630);
  await (await fetch(defaulted.structuredContent.stream.stream_url)).arrayBuffer();

  const overridden = await fixture.client.callTool({
    name: 'tts_open_stream',
    arguments: { request_id: 'fast-override', text: 'hello', rate: 2, delivery: 'stream-required', format: 'pcm_s16le' },
  });
  assert.equal(overridden.structuredContent.stream.requested_rate, 2);
  assert.equal(overridden.structuredContent.stream.duration_ms, 657.5);
  await (await fetch(overridden.structuredContent.stream.stream_url)).arrayBuffer();
});

test('service rejects a default rate outside the MCP contract', () => {
  assert.throws(() => createLocalTtsMcpService({ defaultRate: 0.49 }), /0.5 to 2/);
  assert.throws(() => createLocalTtsMcpService({ defaultRate: 2.01 }), /0.5 to 2/);
});

test('PCM URLs reject a concurrent second consumer and enforce loopback CORS', async t => {
  const fixture = await startFixture(t, { delayMs: 0, chunkDelayMs: 20, minimumDurationMs: 1_000 });
  const stream = await openStream(fixture.client, 'single-use', 'long enough');
  const first = await fetch(stream.stream_url);
  assert.equal(first.status, 200);
  const second = await fetch(stream.stream_url);
  assert.equal(second.status, 409);
  await first.body?.cancel();

  const denied = await fetch(fixture.address.mcpUrl, {
    method: 'OPTIONS',
    headers: { origin: 'https://example.invalid' },
  });
  assert.equal(denied.status, 403);
  const allowed = await fetch(fixture.address.mcpUrl, {
    method: 'OPTIONS',
    headers: { origin: 'http://127.0.0.1:5173' },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
});

test('MCP cancellation aborts an active HTTP synthesis stream', async t => {
  const fixture = await startFixture(t, { delayMs: 0, chunkDelayMs: 15 });
  const stream = await openStream(fixture.client, 'cancel-active', 'a'.repeat(100));
  const response = await fetch(stream.stream_url);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);

  const cancelled = await fixture.client.callTool({
    name: 'tts_cancel_synthesis', arguments: { request_id: 'cancel-active' },
  });
  assert.deepEqual(cancelled.structuredContent, { request_id: 'cancel-active', cancelled: true });
  await Promise.race([
    readUntilEnd(reader),
    new Promise((_, reject) => setTimeout(() => reject(new Error('cancelled PCM stream did not end')), 500)),
  ]);
  assert.equal(fixture.service.diagnostics().streams, 0);
});

test('known-tone acceptance fixture is requested explicitly through MCP', async t => {
  const fixture = await startFixture(t, { delayMs: 0, chunkDelayMs: 0 });
  const result = await fixture.client.callTool({
    name: 'tts_open_stream',
    arguments: {
      request_id: 'known-tone', text: '口型同步测试。', delivery: 'stream-required',
      format: 'pcm_s16le', test_fixture: 'known-tone-v1',
    },
  });
  const response = await fetch(result.structuredContent.stream.stream_url);
  const pcm = new Uint8Array(await response.arrayBuffer());
  assert.equal(pcm.byteLength, 24_000 * 1.6 * 2);
  assert.ok(pcm.some(byte => byte !== 0));
});

async function startFixture(t, options) {
  const service = createLocalTtsMcpService({ port: 0, ...options });
  const address = await service.listen();
  const client = new Client({ name: 'local-tts-mcp-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(address.mcpUrl)));
  t.after(async () => {
    await client.close();
    await service.close();
  });
  return { service, address, client };
}

async function openStream(client, requestId, text) {
  const result = await client.callTool({
    name: 'tts_open_stream',
    arguments: { request_id: requestId, text, delivery: 'stream-required', format: 'pcm_s16le' },
  });
  return result.structuredContent.stream;
}

async function readUntilEnd(reader) {
  while (true) {
    const result = await reader.read();
    if (result.done) return;
  }
}
