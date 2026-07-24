import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  loadTtsConfig,
  parseCharacterConfig,
  validateCharacterExpressionResources,
} from '../src/index.ts';

test('Mao asset-side profile compensates its authored gaze and lip response', async () => {
  const profileUrl = new URL('../../../apps/desktop/public/models/Mao/DesktopChar.character.json', import.meta.url);
  const profile = parseCharacterConfig(JSON.parse(await readFile(profileUrl, 'utf8')), 'models/Mao/DesktopChar.character.json');
  assert.equal(profile.modelJsonUrl, 'models/Mao/Mao.model3.json');
  assert.deepEqual(profile.emotionBindings, {
    neutral: { expression: null },
    happy: { expression: 'exp_02' },
  });
  assert.equal(profile.expressionCatalog?.revision, 1);
  assert.equal(profile.expressionCatalog?.defaultExpressionKey, 'neutral');
  assert.equal(profile.expressionCatalog?.descriptors.length, 8);
  assert.deepEqual(
    profile.expressionCatalog?.descriptors.map(item => item.expressionKey),
    [
      'neutral',
      'closed-eye-smile',
      'eyes-closed-calm',
      'starry-eyed',
      'sad-worried',
      'blushing-uneasy',
      'startled',
      'disdain',
    ],
  );
  assert.equal(profile.gazeProfile.headY.negative.limit, -20);
  assert.equal(profile.gazeProfile.headY.positive.limit, 30);
  assert.deepEqual(profile.gazeProfile.smoothing, { headResponseMs: 120, eyeResponseMs: 45 });
  assert.equal(profile.lipSyncProfile.gain, 2.5);
  assert.deepEqual(
    { attackMs: profile.lipSyncProfile.attackMs, releaseMs: profile.lipSyncProfile.releaseMs, peakHoldMs: profile.lipSyncProfile.peakHoldMs },
    { attackMs: 30, releaseMs: 180, peakHoldMs: 25 },
  );
});

test('Mao expression catalog binds every logical entry to a real model expression', async () => {
  const profileUrl = new URL('../../../apps/desktop/public/models/Mao/DesktopChar.character.json', import.meta.url);
  const modelUrl = new URL('../../../apps/desktop/public/models/Mao/Mao.model3.json', import.meta.url);
  const profile = parseCharacterConfig(
    JSON.parse(await readFile(profileUrl, 'utf8')),
    'models/Mao/DesktopChar.character.json',
  );
  const model = JSON.parse(await readFile(modelUrl, 'utf8')) as {
    FileReferences: { Expressions: Array<{ Name: string }> };
  };
  const available = new Set(model.FileReferences.Expressions.map(item => item.Name));
  const catalog = profile.expressionCatalog;
  assert.ok(catalog);
  validateCharacterExpressionResources(catalog, available);
  assert.equal(Object.keys(catalog.bindings).length, catalog.descriptors.length);
  for (const descriptor of catalog.descriptors) {
    const binding = catalog.bindings[descriptor.expressionKey];
    assert.ok(binding, `missing binding for ${descriptor.expressionKey}`);
    assert.ok(
      binding.expression !== null && available.has(binding.expression),
      `${descriptor.expressionKey} must bind a real expression`,
    );
  }
  assert.deepEqual(
    new Set(Object.values(catalog.bindings).map(binding => binding.expression)),
    available,
  );
  assert.throws(
    () => validateCharacterExpressionResources(catalog, ['exp_01']),
    /unavailable resource exp_02/,
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
  assert.throws(
    () => parseCharacterConfig({
      ...valid,
      emotionBindings: { happy: { expression: 'exp_02' } },
    }),
    /not listed in allowedEmotions/,
  );
  assert.throws(
    () => parseCharacterConfig({
      ...valid,
      emotionBindings: { neutral: { expression: '' } },
    }),
    /non-empty string/,
  );
  assert.throws(() => parseCharacterConfig({ ...valid, lipSynProfile: { gain: 2 } }), /unknown field/);
  const defaults = parseCharacterConfig(valid);
  assert.deepEqual(defaults.emotionBindings, {});
  assert.deepEqual(defaults.gazeProfile.smoothing, { headResponseMs: 120, eyeResponseMs: 45 });
  assert.deepEqual(
    { attackMs: defaults.lipSyncProfile.attackMs, releaseMs: defaults.lipSyncProfile.releaseMs, peakHoldMs: defaults.lipSyncProfile.peakHoldMs },
    { attackMs: 30, releaseMs: 100, peakHoldMs: 25 },
  );
  assert.throws(
    () => parseCharacterConfig({ ...valid, lipSyncProfile: { gain: 1, releaseMs: -1 } }),
    /releaseMs must be non-negative/,
  );
  assert.throws(
    () => parseCharacterConfig({
      ...valid,
      gazeProfile: { ...valid.gazeProfile, smoothing: { headResponseMs: 120, eyeResponseMs: -1 } },
    }),
    /eyeResponseMs must be non-negative/,
  );
  const descriptor = {
    expressionKey: 'neutral',
    label: 'Neutral',
    semanticTags: ['neutral'],
    prototypeTexts: ['Okay.'],
    baseWeight: 1,
    cooldownMs: 0,
    holdMs: { minMs: 100, maxMs: 200 },
    compatibleAvatarStates: ['idle'],
  };
  assert.throws(
    () => parseCharacterConfig({
      ...valid,
      expressionCatalog: {
        revision: 1,
        defaultExpressionKey: 'neutral',
        descriptors: [descriptor],
        bindings: {},
      },
    }),
    /exactly match descriptor keys/,
  );
  assert.throws(
    () => parseCharacterConfig({
      ...valid,
      expressionCatalog: {
        revision: 1,
        defaultExpressionKey: 'missing',
        descriptors: [descriptor],
        bindings: { neutral: { expression: null } },
      },
    }),
    /must reference a descriptor/,
  );
  assert.throws(
    () => parseCharacterConfig({
      ...valid,
      expressionCatalog: {
        revision: 1,
        defaultExpressionKey: 'neutral',
        descriptors: [{ ...descriptor, affectPrototype: { approval: -2 } }],
        bindings: { neutral: { expression: null } },
      },
    }),
    /approval must be from -1 to 1/,
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
