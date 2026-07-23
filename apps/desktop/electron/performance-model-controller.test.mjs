import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createPerformanceModelController } from './performance-model-controller.mjs';

test('external performance Provider becomes operational without owning a process', async () => {
  let launches = 0;
  const controller = createPerformanceModelController(config({
    enabled: true,
    lifecycle: { type: 'external', ...lifecycleDefaults() },
  }), {
    launchProcess: async () => {
      launches += 1;
      return fakeProcess(1);
    },
  });

  await controller.start();
  assert.equal(launches, 0);
  assert.deepEqual(controller.snapshot(), {
    enabled: true,
    operational: true,
    lifecycle: 'external',
    phase: 'ready',
    processId: null,
    lastError: null,
    provider: 'test-provider',
    baseUrl: 'http://127.0.0.1:18090/v1',
    timeoutMs: 5_000,
    maxOutputTokens: 128,
    temperature: 0.1,
    fallbackToRules: true,
  });
  await controller.setEnabled(false);
  assert.equal(controller.snapshot().phase, 'disabled');
  assert.equal(controller.snapshot().operational, false);
});

test('managed performance Provider waits for health and closes its owned process', async () => {
  const process = fakeProcess(4321);
  let healthCalls = 0;
  const controller = createPerformanceModelController(config({
    enabled: true,
    lifecycle: managedLifecycle(),
  }), {
    launchProcess: async () => process,
    fetcher: async () => {
      healthCalls += 1;
      return { ok: true, status: 200 };
    },
  });

  await controller.start();
  assert.equal(healthCalls, 1);
  assert.equal(controller.snapshot().phase, 'ready');
  assert.equal(controller.snapshot().operational, true);
  assert.equal(controller.snapshot().processId, 4321);

  await controller.close();
  assert.deepEqual(process.closeCalls, [5_000]);
  assert.equal(controller.snapshot().phase, 'disabled');
  assert.equal(controller.snapshot().processId, null);
});

test('managed performance Provider restarts after an unexpected entry-process exit', async () => {
  const processes = [fakeProcess(1001), fakeProcess(1002)];
  let launches = 0;
  const controller = createPerformanceModelController(config({
    enabled: true,
    lifecycle: managedLifecycle({ restartOnFailure: true }),
  }), {
    launchProcess: async () => processes[launches++],
    fetcher: async () => ({ ok: true, status: 200 }),
    restartDelayMs: 1,
  });

  await controller.start();
  processes[0].exit(1, null, 'forced test exit');
  await waitFor(() => launches === 2 && controller.snapshot().phase === 'ready');
  assert.equal(controller.snapshot().processId, 1002);
  assert.equal(controller.snapshot().lastError, null);
  await controller.close();
});

test('managed performance Provider remains unavailable when health never becomes ready', async () => {
  const process = fakeProcess(2001);
  const controller = createPerformanceModelController(config({
    enabled: true,
    lifecycle: managedLifecycle({
      startupTimeoutMs: 20,
      restartOnFailure: false,
    }),
  }), {
    launchProcess: async () => process,
    fetcher: async () => ({ ok: false, status: 503 }),
  });

  await controller.start();
  assert.equal(controller.snapshot().phase, 'failed');
  assert.equal(controller.snapshot().operational, false);
  assert.match(controller.snapshot().lastError, /did not become ready/);
  assert.deepEqual(process.closeCalls, [5_000]);
});

function config(overrides = {}) {
  return {
    enabled: false,
    lifecycle: { type: 'external', ...lifecycleDefaults() },
    provider: 'test-provider',
    baseUrl: 'http://127.0.0.1:18090/v1',
    healthUrl: 'http://127.0.0.1:18090/v1/models',
    timeoutMs: 5_000,
    maxOutputTokens: 128,
    temperature: 0.1,
    fallbackToRules: true,
    ...overrides,
  };
}

function lifecycleDefaults() {
  return {
    startupTimeoutMs: 100,
    shutdownTimeoutMs: 5_000,
    healthIntervalMs: 60_000,
    restartOnFailure: false,
  };
}

function managedLifecycle(overrides = {}) {
  return {
    type: 'managed',
    start: { executable: 'test-provider.exe', args: [], cwd: '.', env: {} },
    ...lifecycleDefaults(),
    ...overrides,
  };
}

function fakeProcess(pid) {
  const events = new EventEmitter();
  let exitInfo;
  let resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  return {
    pid,
    closeCalls: [],
    get exitInfo() { return exitInfo; },
    exited,
    async close(timeoutMs) {
      this.closeCalls.push(timeoutMs);
      if (!exitInfo) this.exit(0, null);
      return exitInfo;
    },
    exit(code, signal, stderrTail = '') {
      if (exitInfo) return;
      exitInfo = { code, signal, stdoutTail: '', stderrTail };
      resolveExit(exitInfo);
      events.emit('exit', exitInfo);
    },
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Condition did not become true');
}
