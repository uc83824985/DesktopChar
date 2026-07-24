import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PARAMETER_UPDATE_ORDER,
  ParameterUpdateScheduler,
} from '../src/parameter-update-scheduler.ts';

test('runs updaters by execution order and keeps registration order for ties', () => {
  const scheduler = new ParameterUpdateScheduler<string[]>();
  scheduler.register(updater('expression', PARAMETER_UPDATE_ORDER.EXPRESSION));
  scheduler.register(updater('eye-a', PARAMETER_UPDATE_ORDER.EYE_BLINK));
  scheduler.register(updater('eye-b', PARAMETER_UPDATE_ORDER.EYE_BLINK));
  const calls: string[] = [];

  scheduler.run(calls);

  assert.deepEqual(calls, ['eye-a', 'eye-b', 'expression']);
  assert.deepEqual(scheduler.list(), [
    { id: 'eye-a', executionOrder: 200 },
    { id: 'eye-b', executionOrder: 200 },
    { id: 'expression', executionOrder: 300 },
  ]);
});

test('runtime order changes are applied on the next scheduler run', () => {
  const scheduler = new ParameterUpdateScheduler<string[]>();
  scheduler.register(updater('eye', PARAMETER_UPDATE_ORDER.EYE_BLINK));
  scheduler.register(updater('expression', PARAMETER_UPDATE_ORDER.EXPRESSION));
  scheduler.setExecutionOrder('expression', 100);
  const calls: string[] = [];

  scheduler.run(calls);

  assert.deepEqual(calls, ['expression', 'eye']);
});

test('updaters can be paused without changing their stable order', () => {
  const scheduler = new ParameterUpdateScheduler<string[]>();
  scheduler.register(updater('eye', PARAMETER_UPDATE_ORDER.EYE_BLINK));
  scheduler.register(updater('breath', PARAMETER_UPDATE_ORDER.BREATH));
  scheduler.setEnabled('breath', false);
  const calls: string[] = [];

  scheduler.run(calls);
  assert.deepEqual(calls, ['eye']);
  assert.equal(scheduler.isEnabled('eye'), true);
  assert.equal(scheduler.isEnabled('breath'), false);

  scheduler.setEnabled('breath', true);
  scheduler.run(calls);
  assert.deepEqual(calls, ['eye', 'eye', 'breath']);
  assert.deepEqual(scheduler.list().map(entry => entry.id), ['eye', 'breath']);
});

test('registration validation, duplicate ids, disposal, and clear are explicit', () => {
  const scheduler = new ParameterUpdateScheduler<string[]>();
  const dispose = scheduler.register(updater('eye', PARAMETER_UPDATE_ORDER.EYE_BLINK));
  assert.throws(() => scheduler.register(updater('eye', 201)), /already registered/);
  assert.throws(() => scheduler.register(updater(' invalid ', 201)), /trimmed/);
  assert.throws(() => scheduler.setExecutionOrder('eye', -1), RangeError);
  assert.throws(() => scheduler.setEnabled('missing', false), /not registered/);
  assert.throws(() => scheduler.isEnabled('missing'), /not registered/);
  dispose();
  dispose();
  assert.deepEqual(scheduler.list(), []);
  scheduler.register(updater('expression', PARAMETER_UPDATE_ORDER.EXPRESSION));
  scheduler.clear();
  assert.deepEqual(scheduler.list(), []);
});

function updater(id: string, executionOrder: number) {
  return {
    id,
    executionOrder,
    update(calls: string[]) { calls.push(id); },
  };
}
