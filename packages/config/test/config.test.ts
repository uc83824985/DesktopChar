import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadTtsConfig, parseCharacterConfig } from '../src/index.ts';

test('Mao asset-side profile compensates its authored gaze and lip response', async () => {
  const profileUrl = new URL('../../../apps/desktop/public/models/Mao/DesktopChar.character.json', import.meta.url);
  const profile = parseCharacterConfig(JSON.parse(await readFile(profileUrl, 'utf8')), 'models/Mao/DesktopChar.character.json');
  assert.equal(profile.modelJsonUrl, 'models/Mao/Mao.model3.json');
  assert.equal(profile.gazeProfile.headY.negative.limit, -20);
  assert.equal(profile.gazeProfile.headY.positive.limit, 30);
  assert.equal(profile.lipSyncProfile.gain, 2.5);
  assert.deepEqual(
    { attackMs: profile.lipSyncProfile.attackMs, releaseMs: profile.lipSyncProfile.releaseMs, peakHoldMs: profile.lipSyncProfile.peakHoldMs },
    { attackMs: 30, releaseMs: 180, peakHoldMs: 25 },
  );
});

test('character profile rejects path traversal and unregistered capabilities', () => {
  const valid = {
    version: 1,
    id: 'test',
    model: 'Test.model3.json',
    defaultEmotion: 'neutral',
    allowedEmotions: ['neutral'],
    allowedActions: ['nod'],
    expressionCooldownMs: 0,
    idleReturnDelayMs: 0,
    gazeProfile: {
      headX: axis(-30, 30), headY: axis(-30, 30), eyeX: axis(-1, 1), eyeY: axis(-1, 1),
    },
    lipSyncProfile: { gain: 1 },
  };
  assert.throws(() => parseCharacterConfig({ ...valid, model: '../secret' }), /relative/);
  assert.throws(() => parseCharacterConfig({ ...valid, allowedActions: ['execute-script'] }), /unsupported/);
  assert.throws(() => parseCharacterConfig({ ...valid, lipSynProfile: { gain: 2 } }), /unknown field/);
  const defaults = parseCharacterConfig(valid);
  assert.deepEqual(
    { attackMs: defaults.lipSyncProfile.attackMs, releaseMs: defaults.lipSyncProfile.releaseMs, peakHoldMs: defaults.lipSyncProfile.peakHoldMs },
    { attackMs: 30, releaseMs: 100, peakHoldMs: 25 },
  );
  assert.throws(
    () => parseCharacterConfig({ ...valid, lipSyncProfile: { gain: 1, releaseMs: -1 } }),
    /releaseMs must be non-negative/,
  );
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

function axis(negative: number, positive: number) {
  return {
    negative: { limit: negative, exponent: 1 },
    positive: { limit: positive, exponent: 1 },
    deadZone: 0,
  };
}
