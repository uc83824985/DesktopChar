import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTtsConfig, MAO_CHARACTER_CONFIG } from '../src/index.ts';

test('Mao character profile compensates its stronger authored downward head deformation', () => {
  assert.equal(MAO_CHARACTER_CONFIG.gazeProfile.headY.negative.limit, -20);
  assert.equal(MAO_CHARACTER_CONFIG.gazeProfile.headY.positive.limit, 30);
  assert.equal(MAO_CHARACTER_CONFIG.lipSyncProfile.gain, 2.5);
});

test('loads local MCP defaults and remote MCP binding variables', () => {
  const defaults = loadTtsConfig({});
  assert.equal(defaults.mode, 'local');
  assert.deepEqual(
    { host: defaults.local.host, port: defaults.local.port, defaultRate: defaults.local.defaultRate },
    { host: '127.0.0.1', port: 8766, defaultRate: 1 },
  );
  const config = loadTtsConfig({
    DESKTOP_CHAR_TTS_MODE: 'mcp', DESKTOP_CHAR_TTS_MCP_TOOL: 'voice.generate',
    DESKTOP_CHAR_TTS_MCP_CANCEL_TOOL: 'voice.cancel',
    DESKTOP_CHAR_TTS_TIMEOUT_MS: '1234', DESKTOP_CHAR_TTS_TEXT_ARGUMENT: 'input',
    DESKTOP_CHAR_TTS_REQUEST_ID_ARGUMENT: 'id',
    DESKTOP_CHAR_TTS_FORMAT: 'mp3', DESKTOP_CHAR_TTS_VOICE: 'alice',
  });
  assert.deepEqual(config.mcp, {
    toolName: 'voice.generate', cancelToolName: 'voice.cancel', timeoutMs: 1234,
    requestIdArgument: 'id', textArgument: 'input', format: 'mp3', voice: 'alice',
  });
});

test('rejects invalid TTS environment values', () => {
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_MODE: 'http' }), /local or mcp/);
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_TIMEOUT_MS: '0' }), /positive/);
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_FORMAT: 'aac' }), /pcm_s16le/);
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_LOCAL_DELAY_MS: '-1' }), /non-negative/);
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_LOCAL_RATE: '0.49' }), /0.5 to 2/);
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_LOCAL_RATE: '2.01' }), /0.5 to 2/);
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_LOCAL_MCP_HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_LOCAL_MCP_PORT: '70000' }), /65535/);
});
