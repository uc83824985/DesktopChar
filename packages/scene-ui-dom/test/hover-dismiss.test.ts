import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HoverDismissController,
  type HoverDismissScheduler,
} from '../src/index.ts';

test('hover keeps the panel visible and every leave receives a full timeout', () => {
  const scheduler = new FakeScheduler();
  const phases: string[] = [];
  const controller = new HoverDismissController({
    dismissDelayMs: 3_000,
    fadeOutMs: 120,
    scheduler,
    onPhaseChanged: phase => phases.push(phase),
  });

  controller.show();
  scheduler.advance(2_000);
  controller.trackInside(true);
  scheduler.advance(5_000);
  assert.equal(controller.phase, 'visible');

  controller.trackInside(false);
  scheduler.advance(2_999);
  assert.equal(controller.phase, 'visible');
  scheduler.advance(1);
  assert.equal(controller.phase, 'closing');
  scheduler.advance(120);
  assert.equal(controller.phase, 'hidden');
  assert.deepEqual(phases, ['visible', 'closing', 'hidden']);
});

test('re-entering during fade-out restores the same visible panel', () => {
  const scheduler = new FakeScheduler();
  const controller = new HoverDismissController({
    dismissDelayMs: 3_000,
    fadeOutMs: 120,
    scheduler,
  });

  controller.show();
  scheduler.advance(3_000);
  assert.equal(controller.phase, 'closing');
  controller.trackInside(true);
  scheduler.advance(500);
  assert.equal(controller.phase, 'visible');
  controller.trackInside(false);
  scheduler.advance(3_119);
  assert.equal(controller.phase, 'closing');
  scheduler.advance(1);
  assert.equal(controller.phase, 'hidden');
});

class FakeScheduler implements HoverDismissScheduler {
  #now = 0;
  #nextId = 1;
  readonly #tasks = new Map<number, { at: number; callback: () => void }>();

  set(callback: () => void, delayMs: number): unknown {
    const id = this.#nextId++;
    this.#tasks.set(id, { at: this.#now + delayMs, callback });
    return id;
  }

  clear(handle: unknown): void {
    this.#tasks.delete(handle as number);
  }

  advance(milliseconds: number): void {
    const end = this.#now + milliseconds;
    while (true) {
      const next = [...this.#tasks.entries()]
        .filter(([, task]) => task.at <= end)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.#tasks.delete(id);
      this.#now = task.at;
      task.callback();
    }
    this.#now = end;
  }
}
