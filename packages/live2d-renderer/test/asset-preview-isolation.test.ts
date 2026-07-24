import assert from 'node:assert/strict';
import test from 'node:test';
import { AssetPreviewIsolationController } from '../src/index.ts';

test('locking establishes a neutral baseline and suppresses automatic Idle selection', () => {
  const target = fakeTarget();
  const controller = new AssetPreviewIsolationController(target);

  assert.equal(controller.setLocked(true), true);
  assert.equal(controller.locked, true);
  assert.notEqual(target.groups.idle, 'Idle');
  assert.deepEqual(target.calls, ['motion.stop', 'expression.reset']);
  assert.equal(controller.setLocked(true), false);
});

test('isolated previews clear the other resource class and return motions to stillness', () => {
  const target = fakeTarget();
  const controller = new AssetPreviewIsolationController(target);
  controller.setLocked(true);
  target.calls.length = 0;

  controller.prepareExpressionPreview();
  controller.prepareMotionPreview();
  controller.finishMotionPreview();

  assert.deepEqual(target.calls, [
    'motion.stop', 'expression.reset',
    'motion.stop', 'expression.reset',
    'motion.stop',
  ]);
});

test('unlock and dispose restore the authored Idle group', () => {
  const target = fakeTarget();
  const controller = new AssetPreviewIsolationController(target);
  controller.setLocked(true);
  assert.equal(controller.setLocked(false), true);
  assert.equal(target.groups.idle, 'Idle');
  assert.equal(controller.locked, false);

  controller.setLocked(true);
  controller.dispose();
  assert.equal(target.groups.idle, 'Idle');
  assert.equal(controller.locked, false);
});

function fakeTarget() {
  const calls: string[] = [];
  return {
    calls,
    groups: { idle: 'Idle' },
    stopAllMotions() { calls.push('motion.stop'); },
    expressionManager: {
      resetExpression() { calls.push('expression.reset'); },
    },
  };
}
