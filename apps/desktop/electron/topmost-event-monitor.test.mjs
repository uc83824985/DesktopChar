import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTopmostEventMonitor,
  WM_STYLECHANGED,
  WM_WINDOWPOSCHANGED,
} from './topmost-event-monitor.mjs';

test('coalesces native messages and polls only while an incident is deferred', () => {
  const scheduler = createScheduler();
  const window = createWindow();
  const calls = [];
  const outcomes = ['deferred', 'repaired'];
  const monitor = createTopmostEventMonitor({
    window,
    scheduler,
    reconcile(reason, options) {
      calls.push({ reason, options });
      return outcomes.shift() ?? 'healthy';
    },
  });

  window.messages.get(WM_WINDOWPOSCHANGED)();
  window.messages.get(WM_WINDOWPOSCHANGED)();
  window.messages.get(WM_STYLECHANGED)();
  scheduler.advance(31);
  assert.equal(calls.length, 0);
  scheduler.advance(1);
  assert.deepEqual(calls, [{
    reason: 'wm-windowposchanged+wm-stylechanged',
    options: { deferForForegroundTopmost: true },
  }]);
  assert.deepEqual(monitor.snapshot(), {
    disposed: false,
    eventCheckPending: false,
    incidentRetryActive: true,
    pendingReasons: [],
    nativeMessageCount: 3,
    reconcileCount: 1,
    lastReason: 'wm-windowposchanged+wm-stylechanged',
    lastOutcome: 'deferred',
  });

  scheduler.advance(249);
  assert.equal(calls.length, 1);
  scheduler.advance(1);
  assert.equal(calls[1].reason, 'topmost-incident-retry');
  assert.equal(monitor.snapshot().incidentRetryActive, false);

  scheduler.advance(5_000);
  assert.equal(calls.length, 2);
  monitor.dispose();
});

test('hooks lifecycle events and disposal cancels pending work', () => {
  const scheduler = createScheduler();
  const window = createWindow();
  let calls = 0;
  const monitor = createTopmostEventMonitor({
    window,
    scheduler,
    reconcile() {
      calls += 1;
      return 'healthy';
    },
  });
  assert.deepEqual([...window.messages.keys()], [WM_WINDOWPOSCHANGED, WM_STYLECHANGED]);

  window.listeners.get('always-on-top-changed')();
  monitor.dispose();
  scheduler.advance(1_000);
  assert.equal(calls, 0);
  assert.deepEqual(window.unhooked, [WM_WINDOWPOSCHANGED, WM_STYLECHANGED]);
  assert.equal(window.removed.get('always-on-top-changed'), true);
  assert.equal(monitor.snapshot().disposed, true);
});

test('validates its window and scheduling contract', () => {
  assert.throws(() => createTopmostEventMonitor(), /native window/);
  assert.throws(() => createTopmostEventMonitor({
    window: createWindow(),
    reconcile: () => 'healthy',
    eventDebounceMs: -1,
  }), /delays/);
});

function createWindow() {
  const messages = new Map();
  const listeners = new Map();
  const removed = new Map();
  const unhooked = [];
  return {
    messages,
    listeners,
    removed,
    unhooked,
    hookWindowMessage(message, callback) { messages.set(message, callback); },
    unhookWindowMessage(message) {
      unhooked.push(message);
      messages.delete(message);
    },
    on(event, callback) { listeners.set(event, callback); },
    off(event, callback) { removed.set(event, listeners.get(event) === callback); },
  };
}

function createScheduler() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      tasks.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
    advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const due = [...tasks.entries()]
          .filter(([, task]) => task.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!due) break;
        const [id, task] = due;
        tasks.delete(id);
        now = task.at;
        task.callback();
      }
      now = target;
    },
  };
}
