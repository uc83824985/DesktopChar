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

test('loads standardized TTS lifecycle and synthesis variables', () => {
  const defaults = loadTtsConfig({});
  assert.equal(defaults.lifecycle, 'external');
  const config = loadTtsConfig({
    DESKTOP_CHAR_TTS_LIFECYCLE: 'managed',
    DESKTOP_CHAR_TTS_TIMEOUT_MS: '1234',
    DESKTOP_CHAR_TTS_FORMAT: 'mp3',
    DESKTOP_CHAR_TTS_VOICE: 'alice',
    DESKTOP_CHAR_TTS_RATE: '1.1',
  });
  assert.equal(config.lifecycle, 'managed');
  assert.deepEqual(config.mcp, { timeoutMs: 1234, format: 'mp3', voice: 'alice', rate: 1.1 });
});

test('rejects invalid TTS environment values', () => {
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_LIFECYCLE: 'embedded' }), /managed or external/);
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_TIMEOUT_MS: '0' }), /positive/);
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_FORMAT: 'aac' }), /pcm_s16le/);
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_RATE: '3' }), /0.5 to 2/);
});

function axis(negative: number, positive: number) {
  return {
    negative: { limit: negative, exponent: 1 },
    positive: { limit: positive, exponent: 1 },
    deadZone: 0,
  };
}
