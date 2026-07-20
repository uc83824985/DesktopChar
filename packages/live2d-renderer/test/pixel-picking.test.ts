import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AsyncPixelCoveragePicker,
  PixelCoverageLatch,
  WebGLPixelReadbackBackend,
  toFramebufferPixel,
  type PixelCoverageResult,
  type PixelReadbackBackend,
  type PixelReadbackPoll,
  type PixelReadbackTicket,
  type PixelRgba,
} from '../src/index.ts';

class ControlledTicket implements PixelReadbackTicket {
  result: PixelReadbackPoll = { status: 'pending' };
  disposed = false;

  poll(): PixelReadbackPoll { return this.result; }
  dispose(): void { this.disposed = true; }
  resolve(rgba: PixelRgba): void { this.result = { status: 'ready', rgba }; }
}

class ControlledBackend implements PixelReadbackBackend {
  readonly issued: Array<{ point: { x: number; y: number }; ticket: ControlledTicket }> = [];

  issue(point: { x: number; y: number }): PixelReadbackTicket {
    const ticket = new ControlledTicket();
    this.issued.push({ point, ticket });
    return ticket;
  }
}

test('publishes only the newest cursor readback and derives coverage from alpha', () => {
  const backend = new ControlledBackend();
  const results: PixelCoverageResult[] = [];
  const picker = new AsyncPixelCoveragePicker(backend, { alphaThreshold: 0.5, onResult: result => results.push(result) });

  const first = picker.request({ x: 10, y: 20 });
  picker.afterRender();
  const second = picker.request({ x: 30, y: 40 });
  backend.issued[0]!.ticket.resolve([255, 255, 255, 255]);
  picker.afterRender();
  assert.equal(results.length, 0);
  assert.equal(backend.issued.length, 2);

  backend.issued[1]!.ticket.resolve([100, 80, 60, 127]);
  picker.afterRender();
  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.deepEqual(results, [{
    sequence: 2,
    point: { x: 30, y: 40 },
    rgba: [100, 80, 60, 127],
    covered: false,
    submittedFrame: 2,
    resolvedFrame: 3,
    latencyFrames: 1,
  }]);
});

test('coalesces a point while pending but resamples it after completion for animated coverage', () => {
  const backend = new ControlledBackend();
  const results: PixelCoverageResult[] = [];
  const picker = new AsyncPixelCoveragePicker(backend, { onResult: result => results.push(result) });

  assert.equal(picker.request({ x: 5, y: 6 }), 1);
  picker.afterRender();
  assert.equal(picker.request({ x: 5, y: 6 }), 1);
  assert.equal(backend.issued.length, 1);
  backend.issued[0]!.ticket.resolve([0, 0, 0, 255]);
  picker.afterRender();
  assert.equal(results[0]?.covered, true);

  assert.equal(picker.request({ x: 5, y: 6 }), 2);
  picker.afterRender();
  assert.equal(backend.issued.length, 2);
});

test('watch continuously samples a stationary cursor as animated coverage changes', () => {
  const backend = new ControlledBackend();
  const results: boolean[] = [];
  const picker = new AsyncPixelCoveragePicker(backend, { onResult: result => results.push(result.covered) });

  picker.watch({ x: 7, y: 8 });
  picker.afterRender();
  backend.issued[0]!.ticket.resolve([0, 0, 0, 255]);
  picker.afterRender();
  assert.deepEqual(results, [true]);
  assert.equal(backend.issued.length, 2);

  backend.issued[1]!.ticket.resolve([0, 0, 0, 0]);
  picker.afterRender();
  assert.deepEqual(results, [true, false]);
  assert.equal(backend.issued.length, 3);
  assert.deepEqual(backend.issued[2]!.point, { x: 7, y: 8 });
});

test('stationary cursor exits and re-enters selection as animated coverage moves away and back', () => {
  const backend = new ControlledBackend();
  const latch = new PixelCoverageLatch();
  const results: PixelCoverageResult[] = [];
  const selectedStates: boolean[] = [];
  const transitions: boolean[] = [];
  const point = { x: 21, y: 34 };
  const picker = new AsyncPixelCoveragePicker(backend, {
    onResult(result) {
      results.push(result);
      const decision = latch.update(result.covered);
      selectedStates.push(decision.selected);
      if (decision.changed) transitions.push(decision.selected);
    },
  });

  assert.equal(picker.watch(point), 1);
  picker.afterRender();
  for (const alpha of [255, 0, 0, 0, 255]) {
    backend.issued.at(-1)!.ticket.resolve([0, 0, 0, alpha] as PixelRgba);
    picker.afterRender();
  }

  assert.deepEqual(results.map(result => result.covered), [true, false, false, false, true]);
  assert.deepEqual(selectedStates, [true, true, true, false, true]);
  assert.deepEqual(transitions, [true, false, true]);
  assert.deepEqual(results.map(result => result.submittedFrame), [1, 2, 3, 4, 5]);
  assert.equal(results.every(result => result.sequence === 1), true);
  assert.deepEqual(backend.issued.map(read => read.point), Array.from({ length: 6 }, () => point));
});

test('watch pipelines every render frame and publishes completed reads in submission order', () => {
  const backend = new ControlledBackend();
  const results: PixelCoverageResult[] = [];
  const picker = new AsyncPixelCoveragePicker(backend, {
    maximumPendingReads: 6,
    onResult: result => results.push(result),
  });

  picker.watch({ x: 11, y: 12 });
  picker.afterRender();
  picker.afterRender();
  picker.afterRender();
  assert.equal(backend.issued.length, 3);

  backend.issued[2]!.ticket.resolve([0, 0, 0, 255]);
  picker.afterRender();
  assert.equal(results.length, 0);
  assert.equal(backend.issued.length, 4);

  backend.issued[0]!.ticket.resolve([0, 0, 0, 0]);
  backend.issued[1]!.ticket.resolve([0, 0, 0, 255]);
  picker.afterRender();
  assert.deepEqual(results.map(result => result.submittedFrame), [1, 2, 3]);
  assert.deepEqual(results.map(result => result.covered), [false, true, true]);
  assert.equal(backend.issued.length, 5);
});

test('watch moving inside an actor eventually publishes the newest point despite late older fences', () => {
  const backend = new ControlledBackend();
  const results: PixelCoverageResult[] = [];
  const picker = new AsyncPixelCoveragePicker(backend, { onResult: result => results.push(result) });

  picker.watch({ x: 1, y: 1 });
  picker.afterRender();
  picker.watch({ x: 2, y: 2 });
  picker.afterRender();
  picker.watch({ x: 3, y: 3 });
  backend.issued[0]!.ticket.resolve([0, 0, 0, 255]);
  backend.issued[1]!.ticket.resolve([0, 0, 0, 255]);
  picker.afterRender();
  assert.equal(results.length, 0);
  assert.equal(backend.issued.length, 3);

  backend.issued[2]!.ticket.resolve([0, 0, 0, 255]);
  picker.afterRender();
  assert.deepEqual(results.map(result => result.point), [{ x: 3, y: 3 }]);
  assert.equal(results[0]?.covered, true);
});

test('coverage latch selects promptly but ignores isolated transparent animation samples', () => {
  const latch = new PixelCoverageLatch({ coveredSamplesToSelect: 2, transparentSamplesToClear: 3 });
  assert.equal(latch.update(true).selected, false);
  assert.deepEqual(latch.update(true), {
    selected: true,
    changed: true,
    coveredStreak: 2,
    transparentStreak: 0,
  });
  assert.equal(latch.update(false).selected, true);
  assert.equal(latch.update(true).selected, true);
  assert.equal(latch.update(false).selected, true);
  assert.equal(latch.update(false).selected, true);
  assert.deepEqual(latch.update(false), {
    selected: false,
    changed: true,
    coveredStreak: 0,
    transparentStreak: 3,
  });
});

test('default coverage latch enters immediately and clears after three transparent frames', () => {
  const latch = new PixelCoverageLatch();
  assert.deepEqual(latch.update(true), {
    selected: true,
    changed: true,
    coveredStreak: 1,
    transparentStreak: 0,
  });
  assert.equal(latch.update(false).selected, true);
  assert.equal(latch.update(false).selected, true);
  assert.deepEqual(latch.update(false), {
    selected: false,
    changed: true,
    coveredStreak: 0,
    transparentStreak: 3,
  });
});

test('zero threshold still treats a fully transparent pixel as uncovered', () => {
  const backend = new ControlledBackend();
  const results: PixelCoverageResult[] = [];
  const picker = new AsyncPixelCoveragePicker(backend, { alphaThreshold: 0, onResult: result => results.push(result) });
  picker.request({ x: 0, y: 0 });
  picker.afterRender();
  backend.issued[0]!.ticket.resolve([255, 255, 255, 0]);
  picker.afterRender();
  assert.equal(results[0]?.covered, false);
});

test('invalidating a query prevents a late GPU result from changing selection', () => {
  const backend = new ControlledBackend();
  const results: PixelCoverageResult[] = [];
  const picker = new AsyncPixelCoveragePicker(backend, { onResult: result => results.push(result) });
  picker.request({ x: 1, y: 1 });
  picker.afterRender();
  picker.invalidate();
  backend.issued[0]!.ticket.resolve([0, 0, 0, 255]);
  picker.afterRender();
  assert.deepEqual(results, []);
});

test('maps CSS coordinates to one bottom-left-origin framebuffer pixel at high DPI', () => {
  const rect = { left: 10, top: 20, width: 100, height: 50 };
  assert.deepEqual(toFramebufferPixel({ x: 10, y: 20 }, rect, 200, 100), { x: 0, y: 99 });
  assert.deepEqual(toFramebufferPixel({ x: 109.9, y: 69.9 }, rect, 200, 100), { x: 199, y: 0 });
  assert.equal(toFramebufferPixel({ x: 110, y: 20 }, rect, 200, 100), undefined);
});

test('WebGL2 backend issues a one-pixel PBO read and resolves it after a fence', () => {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const buffer = {} as WebGLBuffer;
  const sync = {} as WebGLSync;
  const fakeGl = {
    PIXEL_PACK_BUFFER: 1,
    PIXEL_PACK_BUFFER_BINDING: 2,
    STREAM_READ: 3,
    RGBA: 4,
    UNSIGNED_BYTE: 5,
    SYNC_GPU_COMMANDS_COMPLETE: 6,
    TIMEOUT_EXPIRED: 7,
    WAIT_FAILED: 8,
    CONDITION_SATISFIED: 9,
    drawingBufferWidth: 200,
    drawingBufferHeight: 100,
    isContextLost: () => false,
    createBuffer: () => buffer,
    getParameter: () => null,
    bindBuffer: (...args: unknown[]) => calls.push({ name: 'bindBuffer', args }),
    bufferData: (...args: unknown[]) => calls.push({ name: 'bufferData', args }),
    readPixels: (...args: unknown[]) => calls.push({ name: 'readPixels', args }),
    fenceSync: () => sync,
    flush: () => calls.push({ name: 'flush', args: [] }),
    clientWaitSync: () => 9,
    getBufferSubData: (_target: number, _offset: number, output: Uint8Array) => output.set([1, 2, 3, 240]),
    deleteSync: () => calls.push({ name: 'deleteSync', args: [] }),
    deleteBuffer: () => calls.push({ name: 'deleteBuffer', args: [] }),
  } as unknown as WebGL2RenderingContext;
  const canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 50 }),
  } as HTMLCanvasElement;
  const backend = new WebGLPixelReadbackBackend(fakeGl, canvas);

  assert.equal(backend.readbackMode, 'async-pbo');
  const ticket = backend.issue({ x: 25, y: 10 });
  assert.deepEqual(ticket.poll(), { status: 'ready', rgba: [1, 2, 3, 240] });
  const read = calls.find(call => call.name === 'readPixels');
  assert.deepEqual(read?.args, [50, 79, 1, 1, 4, 5, 0]);
  ticket.dispose();
  assert.equal(calls.some(call => call.name === 'deleteSync'), true);
  assert.equal(calls.some(call => call.name === 'deleteBuffer'), true);
});

test('WebGL1 backend falls back to a synchronous four-byte read without changing coordinates', () => {
  const reads: unknown[][] = [];
  const fakeGl = {
    RGBA: 4,
    UNSIGNED_BYTE: 5,
    drawingBufferWidth: 100,
    drawingBufferHeight: 50,
    isContextLost: () => false,
    readPixels: (...args: unknown[]) => {
      reads.push(args);
      (args[6] as Uint8Array).set([9, 8, 7, 6]);
    },
  } as unknown as WebGLRenderingContext;
  const canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 50 }),
  } as HTMLCanvasElement;
  const backend = new WebGLPixelReadbackBackend(fakeGl, canvas);

  assert.equal(backend.readbackMode, 'sync-readpixels');
  assert.deepEqual(backend.issue({ x: 12, y: 34 }).poll(), { status: 'ready', rgba: [9, 8, 7, 6] });
  assert.deepEqual(reads[0]?.slice(0, 6), [12, 15, 1, 1, 4, 5]);
});

test('readback footprint keeps the strongest alpha around a high-DPI cursor point', () => {
  const reads: unknown[][] = [];
  const fakeGl = {
    RGBA: 4,
    UNSIGNED_BYTE: 5,
    drawingBufferWidth: 100,
    drawingBufferHeight: 50,
    isContextLost: () => false,
    readPixels: (...args: unknown[]) => {
      reads.push(args);
      const output = args[6] as Uint8Array;
      output.set([1, 2, 3, 7], 0);
      output.set([9, 8, 7, 220], 16);
    },
  } as unknown as WebGLRenderingContext;
  const canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 50 }),
  } as HTMLCanvasElement;
  const backend = new WebGLPixelReadbackBackend(fakeGl, canvas, { sampleRadiusPixels: 1 });

  assert.deepEqual(backend.issue({ x: 12, y: 34 }).poll(), { status: 'ready', rgba: [9, 8, 7, 220] });
  assert.deepEqual(reads[0]?.slice(0, 6), [11, 14, 3, 3, 4, 5]);
  assert.equal((reads[0]?.[6] as Uint8Array).byteLength, 36);
});
