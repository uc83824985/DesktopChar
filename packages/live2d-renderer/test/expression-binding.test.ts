import assert from 'node:assert/strict';
import test from 'node:test';
import { activateRepeatableExpression } from '../src/expression-binding.ts';

test('starts a different expression normally', async () => {
  const neutral = {};
  const happy = {};
  const manager = expressionManager([happy], neutral);
  let starts = 0;

  const result = await activateRepeatableExpression(manager, async id => {
    starts++;
    assert.equal(id, 'happy');
    return true;
  }, 'happy');

  assert.deepEqual(result, { applied: true, mode: 'started' });
  assert.equal(starts, 1);
  assert.equal(manager.restores, 0);
});

test('restores the same remembered expression after a neutral reset', async () => {
  const happy = {};
  const manager = expressionManager([happy], happy);

  const result = await activateRepeatableExpression(manager, async () => {
    throw new Error('the library setter must not reject a repeated expression');
  }, 'happy');

  assert.deepEqual(result, { applied: true, mode: 'restored' });
  assert.equal(manager.restores, 1);
});

test('restores an expression that became current while its resource was loading', async () => {
  const neutral = {};
  const happy = {};
  const manager = expressionManager([happy], neutral);

  const result = await activateRepeatableExpression(manager, async () => {
    manager.currentExpression = happy;
    return false;
  }, 'happy');

  assert.deepEqual(result, { applied: true, mode: 'restored' });
  assert.equal(manager.restores, 1);
});

function expressionManager(expressions: object[], currentExpression: object) {
  return {
    expressions,
    currentExpression,
    restores: 0,
    getExpressionIndex(name: string) {
      return name === 'happy' ? 0 : -1;
    },
    restoreExpression() {
      this.restores++;
    },
  };
}
