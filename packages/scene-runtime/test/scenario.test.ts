import assert from 'node:assert/strict';
import test from 'node:test';
import { selectSceneScenario, type SceneScenario } from '../src/index.ts';

const scenarios: SceneScenario[] = [
  {
    id: 'low-priority',
    operations: [],
    triggers: [{ event: 'idle', priority: 1, weight: 100, cooldownMs: 0 }],
  },
  {
    id: 'weighted-a',
    operations: [],
    triggers: [{ event: 'idle', priority: 2, weight: 1, cooldownMs: 1000 }],
  },
  {
    id: 'weighted-b',
    operations: [],
    triggers: [{ event: 'idle', priority: 2, weight: 3, cooldownMs: 1000 }],
  },
];

test('scenario selection is priority-first, cooldown-aware, and deterministic from supplied randomness', () => {
  assert.equal(selectSceneScenario({
    scenarios,
    event: 'idle',
    nowMs: 5000,
    lastActivatedAt: {},
    randomValue: 0.1,
  })?.id, 'weighted-a');
  assert.equal(selectSceneScenario({
    scenarios,
    event: 'idle',
    nowMs: 5000,
    lastActivatedAt: {},
    randomValue: 0.9,
  })?.id, 'weighted-b');
  assert.equal(selectSceneScenario({
    scenarios,
    event: 'idle',
    nowMs: 5000,
    lastActivatedAt: { 'weighted-a': 4500, 'weighted-b': 4500 },
    randomValue: 0.5,
  })?.id, 'low-priority');
  assert.equal(selectSceneScenario({
    scenarios,
    event: 'unknown',
    nowMs: 5000,
    lastActivatedAt: {},
    randomValue: 0,
  }), undefined);
});

test('scenario selection rejects invalid scheduling data instead of silently changing policy', () => {
  assert.throws(() => selectSceneScenario({
    scenarios: [{
      id: 'invalid',
      operations: [],
      triggers: [{ event: 'idle', priority: 1, weight: 0, cooldownMs: 0 }],
    }],
    event: 'idle',
    nowMs: 0,
    lastActivatedAt: {},
    randomValue: 0,
  }), /weight must be positive/);
});
