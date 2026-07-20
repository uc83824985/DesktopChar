import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTtsConfig } from '../src/index.ts';

test('loads offline mock defaults and MCP binding variables', () => {
  assert.equal(loadTtsConfig({}).mode, 'mock');
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
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_MODE: 'http' }), /mock or mcp/);
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_TIMEOUT_MS: '0' }), /positive/);
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_FORMAT: 'aac' }), /pcm_s16le/);
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_MOCK_DELIVERY: 'chunks' }), /stream or artifact/);
});
