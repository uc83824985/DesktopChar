import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HoldDragController,
  type HoldDragCallbacks,
  type HoldDragScheduler,
} from '../src/index.ts';

class ManualScheduler implements HoldDragScheduler {
  callback: (() => void) | undefined;
  delayMs: number | undefined;

  set(callback: () => void, delayMs: number): unknown {
    this.callback = callback;
    this.delayMs = delayMs;
    return callback;
  }

  clear(handle: unknown): void {
    if (this.callback === handle) this.callback = undefined;
  }

  fire(): void {
    const callback = this.callback;
    this.callback = undefined;
    callback?.();
  }
}

function fixture(overrides: Partial<HoldDragCallbacks<string>> = {}) {
  const scheduler = new ManualScheduler();
  const facts = { phases: [] as string[], starts: [] as Array<{ x: number; y: number }>, moves: [] as Array<{ x: number; y: number }>, clicks: [] as string[], finishes: 0 };
  const controller = new HoldDragController({
    holdDelayMs: 240,
    scheduler,
    callbacks: {
      onPhaseChanged: phase => { facts.phases.push(phase); },
      onHoldStarted: point => { facts.starts.push({ ...point }); },
      onDragMoved: point => { facts.moves.push({ ...point }); },
      onDragFinished: () => { facts.finishes++; },
      onClicked: target => { facts.clicks.push(target); },
      ...overrides,
    },
  });
  return { controller, scheduler, facts };
}

test('short single and double clicks never enter the drag phase', () => {
  const { controller, scheduler, facts } = fixture();
  assert.equal(controller.begin(1, 'avatar', { x: 10, y: 10 }), true);
  assert.equal(scheduler.delayMs, 240);
  controller.end(1, { x: 11, y: 10 });
  assert.equal(controller.begin(2, 'avatar', { x: 10, y: 10 }), true);
  controller.end(2, { x: 10, y: 10 });

  assert.deepEqual(facts.clicks, ['avatar', 'avatar']);
  assert.deepEqual(facts.starts, []);
  assert.equal(facts.phases.includes('starting'), false);
  assert.equal(facts.finishes, 0);
});

test('a hold activates dragging from the latest point without jumping', async () => {
  const { controller, scheduler, facts } = fixture();
  controller.begin(7, 'avatar', { x: 10, y: 10 });
  controller.move(7, { x: 30, y: 25 });
  scheduler.fire();
  await Promise.resolve();

  assert.deepEqual(facts.starts, [{ x: 30, y: 25 }]);
  assert.deepEqual(facts.moves, []);
  controller.move(7, { x: 34, y: 28 });
  controller.end(7, { x: 35, y: 29 });
  assert.deepEqual(facts.moves, [{ x: 34, y: 28 }, { x: 35, y: 29 }]);
  assert.equal(facts.finishes, 1);
  assert.deepEqual(facts.clicks, []);
});

test('release while native drag startup is pending still closes drag exactly once', async () => {
  let resolveStart!: () => void;
  const started = new Promise<void>(resolve => { resolveStart = resolve; });
  const { controller, scheduler, facts } = fixture({ onHoldStarted: () => started });
  controller.begin(3, 'avatar', { x: 1, y: 2 });
  scheduler.fire();
  controller.end(3, { x: 1, y: 2 });
  assert.equal(facts.finishes, 0);
  resolveStart();
  await started;
  await Promise.resolve();
  assert.equal(facts.finishes, 1);
  assert.deepEqual(facts.clicks, []);
});

test('hold delay rejects values at or above one second', () => {
  assert.throws(() => fixture().controller.setHoldDelayMs(1_000), /0 and 999/);
});
