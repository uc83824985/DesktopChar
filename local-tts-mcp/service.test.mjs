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
    sampleRateHz: 24_000, channels: 1, durationMs: undefined,
  });
  const response = await fetch(stream.stream_url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/pcm');
  assert.equal(response.headers.get('content-length'), null, 'the data plane must remain chunked');
  const pcm = new Uint8Array(await response.arrayBuffer());
  assert.equal(pcm.byteLength, 24_000, 'minimum 500 ms mono pcm_s16le stream');
  assert.ok(pcm.some(byte => byte !== 0));
  assert.equal(fixture.service.diagnostics().streams, 0);
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
