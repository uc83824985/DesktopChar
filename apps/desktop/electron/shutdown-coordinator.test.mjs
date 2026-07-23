import assert from 'node:assert/strict';
import test from 'node:test';
import { createShutdownCoordinator } from './shutdown-coordinator.mjs';

test('shutdown hides the visible avatar synchronously before managed cleanup', async () => {
  const events = [];
  let releaseCleanup;
  const cleanup = new Promise(resolve => { releaseCleanup = resolve; });
  const coordinator = createShutdownCoordinator({
    hidePresentation(reason) { events.push(`hide:${reason}`); },
    async closeResources(reason) {
      events.push(`close-start:${reason}`);
      await cleanup;
      events.push(`close-end:${reason}`);
    },
    finish(reason) { events.push(`finish:${reason}`); },
  });

  const shuttingDown = coordinator.request('avatar-menu');
  assert.deepEqual(events, ['hide:avatar-menu', 'close-start:avatar-menu']);
  assert.equal(coordinator.completed, false);
  releaseCleanup();
  await shuttingDown;
  assert.deepEqual(events, [
    'hide:avatar-menu',
    'close-start:avatar-menu',
    'close-end:avatar-menu',
    'finish:avatar-menu',
  ]);
});

test('normal quit, Ctrl+C and repeated requests share one shutdown transaction', async () => {
  const reasons = [];
  const coordinator = createShutdownCoordinator({
    hidePresentation(reason) { reasons.push(`hide:${reason}`); },
    async closeResources(reason) { reasons.push(`close:${reason}`); },
    finish(reason) { reasons.push(`finish:${reason}`); },
  });
  const event = {
    prevented: false,
    preventDefault() { this.prevented = true; },
  };

  coordinator.handleBeforeQuit(event);
  await coordinator.request('SIGINT');
  await coordinator.request('forced-repeat');
  assert.equal(event.prevented, true);
  assert.deepEqual(reasons, ['hide:before-quit', 'close:before-quit', 'finish:before-quit']);
  assert.equal(coordinator.completed, true);

  const completedEvent = {
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
  coordinator.handleBeforeQuit(completedEvent);
  assert.equal(completedEvent.prevented, false);
});
