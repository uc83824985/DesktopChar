import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  loadTtsConfig,
  parseCharacterConfig,
  validateCharacterActionResources,
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
  assert.equal(profile.actionCatalog?.revision, 1);
  assert.deepEqual(
    profile.actionCatalog?.descriptors.map(item => item.actionId),
    [
      'penguin-double-wave',
      'hands-behind-sway',
      'adjust-wizard-hat',
      'draw-heart-success',
      'draw-heart-failure',
      'summon-rabbit-buff',
    ],
  );
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

test('Mao action catalog binds every reviewed action and excludes the render sample', async () => {
  const profileUrl = new URL('../../../apps/desktop/public/models/Mao/DesktopChar.character.json', import.meta.url);
  const modelUrl = new URL('../../../apps/desktop/public/models/Mao/Mao.model3.json', import.meta.url);
  const profile = parseCharacterConfig(
    JSON.parse(await readFile(profileUrl, 'utf8')),
    'models/Mao/DesktopChar.character.json',
  );
  const model = JSON.parse(await readFile(modelUrl, 'utf8')) as {
    FileReferences: { Motions: Record<string, Array<{ File: string }>> };
  };
  const available = Object.entries(model.FileReferences.Motions).flatMap(([group, motions]) => (
    motions.map((_, index) => ({ group, index }))
  ));
  const catalog = profile.actionCatalog;
  assert.ok(catalog);
  validateCharacterActionResources(catalog, available);
  assert.equal(catalog.descriptors.length, 6);
  assert.equal(Object.keys(catalog.bindings).length, 6);
  const ambientDescriptors = catalog.descriptors.filter(descriptor => (
    descriptor.triggers.some(rule => rule.trigger === 'ambient.opportunity')
  ));
  const ambientRules = ambientDescriptors.flatMap(descriptor => (
    descriptor.triggers.filter(rule => rule.trigger === 'ambient.opportunity')
  ));
  assert.equal(ambientRules.length, 3);
  assert.deepEqual(
    ambientDescriptors.map(descriptor => descriptor.actionId),
    ['penguin-double-wave', 'hands-behind-sway', 'adjust-wizard-hat'],
  );
  for (const rule of ambientRules) {
    assert.equal(rule.mode, 'optional');
    assert.ok(rule.chance >= 0 && rule.chance <= 1);
    assert.ok(rule.weight > 0);
  }
  assert.deepEqual(
    ambientDescriptors.map(descriptor => (
      descriptor.triggers.some(rule => rule.trigger === 'conversation.completed')
    )),
    [true, true, true],
  );
  assert.equal(
    Object.values(catalog.bindings).some(binding => binding.group === 'Idle' && binding.index === 1),
    false,
  );
  assert.throws(
    () => validateCharacterActionResources(catalog, [{ group: 'TapBody', index: 0 }]),
    /unavailable motion TapBody\[1\]/,
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
  assert.deepEqual(
    catalog.descriptors.find(descriptor => descriptor.expressionKey === 'sad-worried')
      ?.blockedActionTags,
    ['ambient'],
  );
  assert.ok(
    catalog.descriptors
      .filter(descriptor => descriptor.expressionKey !== 'sad-worried')
      .every(descriptor => descriptor.blockedActionTags?.length === 0),
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
  assert.throws(
    () => parseCharacterConfig({
      ...valid,
      allowedActions: ['wave'],
      actionCatalog: {
        revision: 1,
        descriptors: [{
          actionId: 'wave',
          label: 'Wave',
          semanticTags: ['ambient'],
          prototypeTexts: ['Hello'],
          allowedAnchors: ['segment-start'],
          compatibleAvatarStates: ['idle'],
          scene: {},
          speech: 'deny',
          priority: 1,
          cooldownMs: 0,
          maxQueueAgeMs: 1_000,
          busyPolicy: 'enqueue',
          triggers: [{
            ruleId: 'ambient',
            trigger: 'ambient.opportunity',
            mode: 'optional',
            chance: 1,
            weight: 1,
          }],
        }],
        bindings: {
          wave: {
            type: 'live2d-motion',
            group: 'TapBody',
            index: 0,
            mode: 'once',
            expectedDurationMs: 1_000,
          },
        },
      },
      expressionCatalog: {
        revision: 1,
        defaultExpressionKey: 'neutral',
        descriptors: [{ ...descriptor, blockedActionTags: ['ambinet'] }],
        bindings: { neutral: { expression: null } },
      },
    }),
    /unknown action tags: ambinet/,
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
    DESKTOP_CHAR_TTS_FALLBACK_CHARACTERS_PER_SECOND: '6.25',
  });
  assert.equal(config.lifecycle, 'managed');
  assert.deepEqual(config.mcp, { timeoutMs: 1234, format: 'mp3', voice: 'alice', rate: 1.1 });
  assert.deepEqual(config.timing, { fallbackCharactersPerSecond: 6.25 });
});

test('rejects invalid TTS environment values', () => {
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_LIFECYCLE: 'embedded' }), /managed or external/);
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_TIMEOUT_MS: '0' }), /positive/);
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_FORMAT: 'aac' }), /pcm_s16le/);
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_RATE: '3' }), /0.5 to 2/);
  assert.throws(() => loadTtsConfig({ DESKTOP_CHAR_TTS_FALLBACK_CHARACTERS_PER_SECOND: '0' }), /positive/);
});

function axis(negative: number, positive: number) {
  return {
    negative: { limit: negative, exponent: 1 },
    positive: { limit: positive, exponent: 1 },
    deadZone: 0,
  };
}
