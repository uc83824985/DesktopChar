import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseTtsStatusResult,
  validateTtsMcpTools,
} from '../../../tts-mcp-profile/contract.mjs';

test('DesktopChar TTS Profile requires status, open-stream and cancellation schemas', () => {
  const catalog = validateTtsMcpTools([
    tool('tts_status', [], ['profile', 'profile_version', 'provider', 'status', 'accepting_requests', 'capabilities']),
    tool('tts_open_stream', ['request_id', 'text'], ['stream']),
    tool('tts_cancel_synthesis', ['request_id'], ['request_id', 'cancelled']),
  ]);
  assert.equal(catalog.toolCount, 3);
  assert.throws(() => validateTtsMcpTools([
    tool('tts_open_stream', ['request_id', 'text'], ['stream']),
    tool('tts_cancel_synthesis', ['request_id'], ['request_id', 'cancelled']),
  ]), /tts_status/);
});

test('tts_status identifies an accepting DesktopChar streaming Provider', () => {
  const status = parseTtsStatusResult({
    structuredContent: {
      profile: 'desktop-char.tts.streaming',
      profile_version: 1,
      provider: 'fixture-tts',
      status: 'ready',
      accepting_requests: true,
      capabilities: {
        streaming: true, cancellation: true, formats: ['pcm_s16le'], voices: [],
        text_cues: false, test_fixtures: [],
      },
    },
  });
  assert.equal(status.provider, 'fixture-tts');
  assert.throws(() => parseTtsStatusResult({
    structuredContent: { ...status, accepting_requests: false },
  }), /not accepting requests/);
});

function tool(name, inputFields, outputFields) {
  return {
    name,
    inputSchema: { type: 'object', properties: Object.fromEntries(inputFields.map(field => [field, { type: 'string' }])), required: inputFields },
    outputSchema: { type: 'object', properties: Object.fromEntries(outputFields.map(field => [field, {}])), required: outputFields },
  };
}
