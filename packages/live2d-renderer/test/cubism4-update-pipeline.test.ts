import assert from 'node:assert/strict';
import test from 'node:test';
import {
  installCubism4UpdatePipeline,
  type Cubism4UpdateTarget,
} from '../src/cubism4-update-pipeline.ts';

test('orders automatic eye blink before expression and Runtime final submission', () => {
  const { target, calls } = fakeTarget(false);
  const handle = installCubism4UpdatePipeline(target);

  target.update(16, 5_570);

  assert.deepEqual(calls, [
    'focus-controller',
    'event:beforeMotionUpdate',
    'motion',
    'event:afterMotionUpdate',
    'save',
    'eye-blink',
    'expression',
    'gaze-focus',
    'breath',
    'physics',
    'pose',
    'event:beforeModelUpdate',
    'core-update',
    'load',
  ]);
  assert.deepEqual(handle.scheduler.list().map(updater => updater.id), [
    'cubism.eye-blink',
    'cubism.expression',
    'cubism.gaze-focus',
    'cubism.breath',
    'cubism.physics',
    'cubism.pose',
    'desktop-char.runtime-final',
  ]);
});

test('keeps motion-authored eye parameters by skipping automatic blink', () => {
  const { target, calls } = fakeTarget(true);
  installCubism4UpdatePipeline(target);

  target.update(16, 1_000);

  assert.equal(calls.includes('eye-blink'), false);
  assert.ok(calls.indexOf('expression') < calls.indexOf('event:beforeModelUpdate'));
});

test('can pause natural breath while preserving automatic eye blink', () => {
  const { target, calls } = fakeTarget(false);
  const handle = installCubism4UpdatePipeline(target);
  handle.scheduler.setEnabled('cubism.breath', false);

  target.update(16, 1_000);

  assert.equal(calls.includes('breath'), false);
  assert.equal(calls.includes('eye-blink'), true);
  handle.scheduler.setEnabled('cubism.breath', true);
  calls.length = 0;
  target.update(16, 1_016);
  assert.equal(calls.includes('breath'), true);
});

test('installation is idempotent and restore returns the original instance method', () => {
  const { target, calls, destroy } = fakeTarget(false);
  const originalUpdate = target.update;
  const first = installCubism4UpdatePipeline(target);
  const second = installCubism4UpdatePipeline(target);
  assert.equal(first, second);
  assert.notEqual(target.update, originalUpdate);

  first.restore();
  first.restore();
  assert.equal(target.update, originalUpdate);
  target.update(10, 20);
  assert.deepEqual(calls, ['original-update']);

  const third = installCubism4UpdatePipeline(target);
  destroy();
  assert.equal(third.active, false);
  assert.equal(target.update, originalUpdate);
});

function fakeTarget(motionUpdated: boolean): {
  target: Cubism4UpdateTarget;
  calls: string[];
  destroy: () => void;
} {
  const calls: string[] = [];
  let destroyListener: (() => void) | undefined;
  const coreModel = {
    saveParameters() { calls.push('save'); },
    update() { calls.push('core-update'); },
    loadParameters() { calls.push('load'); },
  };
  const target: Cubism4UpdateTarget = {
    coreModel,
    motionManager: {
      update() {
        calls.push('motion');
        return motionUpdated;
      },
      expressionManager: {
        update() {
          calls.push('expression');
          return true;
        },
      },
    },
    focusController: {
      update() { calls.push('focus-controller'); },
    },
    eyeBlink: {
      updateParameters() { calls.push('eye-blink'); },
    },
    physics: {
      evaluate() { calls.push('physics'); },
    },
    pose: {
      updateParameters() { calls.push('pose'); },
    },
    updateFocus() { calls.push('gaze-focus'); },
    updateNaturalMovements() { calls.push('breath'); },
    update() { calls.push('original-update'); },
    emit(event) {
      calls.push(`event:${event}`);
      return true;
    },
    once(event, listener) {
      assert.equal(event, 'destroy');
      destroyListener = listener;
    },
    off(event, listener) {
      assert.equal(event, 'destroy');
      if (destroyListener === listener) destroyListener = undefined;
    },
  };
  return {
    target,
    calls,
    destroy: () => destroyListener?.(),
  };
}
