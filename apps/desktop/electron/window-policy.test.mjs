import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDragAvatarBounds,
  clampBoundsToWorkArea,
  dragAvatarBounds,
  describePointerPresentationChange,
  initialAvatarBounds,
  isScreenPoint,
  parseDragHoldDelayMs,
  parseLoopbackDevUrl,
} from './window-policy.mjs';

const workArea = { x: 100, y: 50, width: 1_200, height: 800 };

test('places the avatar window at the work-area bottom right with a safe margin', () => {
  assert.deepEqual(initialAvatarBounds(workArea, { width: 460, height: 700 }, 24), {
    x: 816, y: 126, width: 460, height: 700,
  });
});

test('dragging preserves size and clamps the complete avatar bounds to the selected display', () => {
  const start = { x: 800, y: 100, width: 460, height: 700 };
  assert.deepEqual(dragAvatarBounds(start, { x: 900, y: 300 }, { x: 400, y: -100 }, workArea), {
    x: 300, y: 50, width: 460, height: 700,
  });
  assert.deepEqual(clampBoundsToWorkArea({ x: 2_000, y: 2_000, width: 460, height: 700 }, workArea), {
    x: 840, y: 150, width: 460, height: 700,
  });
});

test('dragging uses the stable bounds path and skips duplicate compositor submissions', () => {
  const submissions = [];
  const target = {
    getBounds: () => ({ x: 10, y: 20, width: 460, height: 700 }),
    setBounds: (bounds, animate) => { submissions.push([bounds, animate]); },
  };
  assert.equal(applyDragAvatarBounds(target, { x: 30, y: 40, width: 460, height: 700 }), true);
  assert.deepEqual(submissions, [[{ x: 30, y: 40, width: 460, height: 700 }, false]]);
  assert.equal(applyDragAvatarBounds(target, { x: 10, y: 20, width: 460, height: 700 }), false);
  assert.equal(submissions.length, 1);
});

test('screen-point validation rejects non-finite IPC input', () => {
  assert.equal(isScreenPoint({ x: 1, y: 2 }), true);
  assert.equal(isScreenPoint({ x: Number.NaN, y: 2 }), false);
  assert.equal(isScreenPoint(null), false);
});

test('development renderer URL is restricted to an HTTP loopback origin', () => {
  assert.equal(parseLoopbackDevUrl('http://127.0.0.1:5173'), 'http://127.0.0.1:5173/');
  assert.equal(parseLoopbackDevUrl(undefined), undefined);
  assert.throws(() => parseLoopbackDevUrl('https://example.com'), /loopback/);
  assert.throws(() => parseLoopbackDevUrl('file:///tmp/index.html'), /loopback/);
});

test('drag hold delay is configurable but remains below one second', () => {
  assert.equal(parseDragHoldDelayMs(undefined), 240);
  assert.equal(parseDragHoldDelayMs('320'), 320);
  assert.equal(parseDragHoldDelayMs('0'), 0);
  assert.throws(() => parseDragHoldDelayMs('1000'), /between 0 and 999/);
  assert.throws(() => parseDragHoldDelayMs('1.5'), /between 0 and 999/);
});

test('drag cursor activation does not resubmit unchanged mouse passthrough', () => {
  assert.deepEqual(describePointerPresentationChange(
    { passthrough: false, cursor: 'pointer' },
    { passthrough: false, cursor: 'move' },
    true,
  ), {
    passthroughChanged: false,
    cursorChanged: true,
    enteredInteractive: false,
    refreshCursor: true,
  });
  assert.equal(describePointerPresentationChange(
    { passthrough: true, cursor: 'default' },
    { passthrough: true, cursor: 'default' },
    false,
  ).passthroughChanged, true);
});
