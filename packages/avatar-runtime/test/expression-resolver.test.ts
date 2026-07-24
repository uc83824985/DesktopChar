import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type {
  CharacterExpressionCatalog,
  ExpressionDescriptor,
} from '../../contracts/src/index.ts';
import { parseCharacterConfig } from '../../config/src/index.ts';
import { resolveExpression } from '../src/index.ts';

test('a high-confidence catalog candidate resolves without exposing a renderer binding', () => {
  const catalog = fixtureCatalog();
  const result = resolveExpression({
    catalog,
    avatarState: 'speaking',
    resolutionId: 'segment-1',
    randomSeed: 42,
    nowMs: 1_000,
    candidates: [
      { expressionKey: 'smile', confidence: 0.95, intensity: 0.8 },
      { expressionKey: 'worried', confidence: 0.2, intensity: 0.4 },
    ],
  });
  assert.deepEqual(
    {
      expressionKey: result.expressionKey,
      intensity: result.intensity,
      holdMs: result.holdMs,
      source: result.source,
    },
    { expressionKey: 'smile', intensity: 0.8, holdMs: 1800, source: 'candidate' },
  );
  assert.equal('expression' in result, false);
});

test('affect prototypes adapt the same text-independent resolver to different character catalogs', () => {
  const positive = {
    valence: 0.9,
    arousal: 0.6,
    approval: 0.8,
    engagement: 0.8,
    certainty: 0.8,
  };
  const first = resolveExpression({
    catalog: fixtureCatalog(),
    avatarState: 'speaking',
    resolutionId: 'same-segment',
    randomSeed: 7,
    nowMs: 1_000,
    affect: positive,
  });
  const alternate = fixtureCatalog();
  alternate.descriptors = alternate.descriptors.map(descriptor => (
    descriptor.expressionKey === 'smile'
      ? { ...descriptor, expressionKey: 'sunny' }
      : descriptor
  ));
  alternate.defaultExpressionKey = 'neutral';
  alternate.bindings = {
    neutral: { expression: 'other-neutral' },
    sunny: { expression: 'other-positive' },
    worried: { expression: 'other-negative' },
  };
  const second = resolveExpression({
    catalog: alternate,
    avatarState: 'speaking',
    resolutionId: 'same-segment',
    randomSeed: 7,
    nowMs: 1_000,
    affect: positive,
  });
  assert.equal(first.expressionKey, 'smile');
  assert.equal(second.expressionKey, 'sunny');
});

test('cooldown and current-expression repetition are Runtime-owned resolution inputs', () => {
  const result = resolveExpression({
    catalog: fixtureCatalog(),
    avatarState: 'speaking',
    resolutionId: 'segment-2',
    randomSeed: 11,
    nowMs: 1_500,
    currentExpressionKey: 'smile',
    history: [{ expressionKey: 'smile', selectedAtMs: 1_000 }],
    candidates: [{ expressionKey: 'smile', confidence: 0.95, intensity: 0.9 }],
  });
  assert.notEqual(result.expressionKey, 'smile');
});

test('resolution is reproducible for a fixed seed and never escapes the legal catalog', () => {
  const input = {
    catalog: fixtureCatalog(),
    avatarState: 'speaking' as const,
    resolutionId: 'segment-3',
    nowMs: 2_000,
    candidates: [
      { expressionKey: 'smile', confidence: 0.55, intensity: 0.6 },
      { expressionKey: 'worried', confidence: 0.55, intensity: 0.6 },
    ],
  };
  const first = resolveExpression({ ...input, randomSeed: 99 });
  const repeated = resolveExpression({ ...input, randomSeed: 99 });
  assert.deepEqual(repeated, first);
  for (let seed = 0; seed < 20; seed++) {
    const selected = resolveExpression({ ...input, randomSeed: seed });
    assert.ok(['smile', 'worried'].includes(selected.expressionKey));
  }
});

test('unknown and duplicate candidates are rejected before selection', () => {
  const base = {
    catalog: fixtureCatalog(),
    avatarState: 'speaking' as const,
    resolutionId: 'segment-4',
    randomSeed: 1,
    nowMs: 1_000,
  };
  assert.throws(
    () => resolveExpression({
      ...base,
      candidates: [{ expressionKey: 'missing', confidence: 1, intensity: 1 }],
    }),
    /not in the catalog/,
  );
  assert.throws(
    () => resolveExpression({
      ...base,
      candidates: [
        { expressionKey: 'smile', confidence: 0.8, intensity: 0.8 },
        { expressionKey: 'smile', confidence: 0.7, intensity: 0.7 },
      ],
    }),
    /duplicated/,
  );
});

test('every enabled Mao expression is reachable through its logical catalog key', async () => {
  const profileUrl = new URL(
    '../../../apps/desktop/public/models/Mao/DesktopChar.character.json',
    import.meta.url,
  );
  const profile = parseCharacterConfig(
    JSON.parse(await readFile(profileUrl, 'utf8')),
    'models/Mao/DesktopChar.character.json',
  );
  const catalog = profile.expressionCatalog;
  assert.ok(catalog);
  for (const [index, descriptor] of catalog.descriptors.entries()) {
    const result = resolveExpression({
      catalog,
      avatarState: 'speaking',
      resolutionId: `mao-reachability-${descriptor.expressionKey}`,
      randomSeed: index,
      nowMs: 10_000,
      candidates: [{
        expressionKey: descriptor.expressionKey,
        confidence: 1,
        intensity: 0.7,
      }],
    });
    assert.equal(result.expressionKey, descriptor.expressionKey);
    assert.ok(catalog.bindings[result.expressionKey]);
  }
});

function fixtureCatalog(): CharacterExpressionCatalog {
  const descriptors: ExpressionDescriptor[] = [
    descriptor('neutral', { valence: 0, arousal: 0.2, approval: 0, engagement: 0.5, certainty: 0.7 }, 0),
    descriptor('smile', { valence: 0.9, arousal: 0.6, approval: 0.8, engagement: 0.8, certainty: 0.8 }, 2_000),
    descriptor('worried', { valence: -0.8, arousal: 0.4, approval: 0, engagement: 0.8, certainty: 0.3 }, 2_000),
  ];
  return {
    revision: 1,
    defaultExpressionKey: 'neutral',
    descriptors,
    bindings: {
      neutral: { expression: 'exp-neutral' },
      smile: { expression: 'exp-smile' },
      worried: { expression: 'exp-worried' },
    },
  };
}

function descriptor(
  expressionKey: string,
  affectPrototype: NonNullable<ExpressionDescriptor['affectPrototype']>,
  cooldownMs: number,
): ExpressionDescriptor {
  return {
    expressionKey,
    label: expressionKey,
    semanticTags: [expressionKey],
    prototypeTexts: [expressionKey],
    affectPrototype,
    baseWeight: 1,
    cooldownMs,
    holdMs: { minMs: 1_000, maxMs: 2_000 },
    compatibleAvatarStates: ['idle', 'listening', 'thinking', 'speaking', 'presenting'],
  };
}
