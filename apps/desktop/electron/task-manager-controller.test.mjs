import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskManagerController } from './task-manager-controller.mjs';

test('Task Manager controller stores bounded events before ack and deduplicates polls', async () => {
  const client = new FakeClient();
  client.pages.push({
    earliestCursor: 1,
    latestCursor: 1,
    gap: false,
    events: [taskEvent(1, 'task-completed')],
  });
  client.pages.push({
    earliestCursor: 1,
    latestCursor: 1,
    gap: false,
    events: [],
  });
  const controller = createTaskManagerController(config(), {
    createClient: () => client,
  });
  await controller.pollNow();
  await controller.pollNow();
  const snapshot = controller.snapshot();
  assert.equal(snapshot.phase, 'ready');
  assert.equal(snapshot.cursor, 1);
  assert.equal(snapshot.pendingAckCount, 0);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].visibleTextTail, '完成');
  assert.deepEqual(client.acked, ['event-1']);
  await controller.close();
});

test('ack failure keeps the stored event pending and retries without losing it', async () => {
  const client = new FakeClient();
  client.ackFailures = 1;
  client.pages.push({
    earliestCursor: 1,
    latestCursor: 1,
    gap: false,
    events: [taskEvent(1, 'task-failed')],
  });
  client.pages.push({
    earliestCursor: 1,
    latestCursor: 1,
    gap: false,
    events: [],
  });
  const controller = createTaskManagerController(config(), {
    createClient: () => client,
  });
  await controller.pollNow();
  assert.equal(controller.snapshot().phase, 'degraded');
  assert.equal(controller.snapshot().pendingAckCount, 1);
  assert.equal(controller.snapshot().events.length, 1);
  await controller.pollNow();
  assert.equal(controller.snapshot().phase, 'ready');
  assert.equal(controller.snapshot().pendingAckCount, 0);
  assert.equal(controller.snapshot().events.length, 1);
  await controller.close();
});

test('a new Task Manager instance resets its cursor without discarding saved DesktopChar facts', async () => {
  const client = new FakeClient();
  client.pages.push({
    earliestCursor: 1,
    latestCursor: 2,
    gap: false,
    events: [taskEvent(2, 'task-completed')],
  });
  client.pages.push({
    earliestCursor: 1,
    latestCursor: 1,
    gap: false,
    events: [taskEvent(1, 'task-unavailable')],
  });
  const controller = createTaskManagerController(config(), {
    createClient: () => client,
  });
  await controller.pollNow();
  client.instanceId = 'instance-b';
  await controller.pollNow();
  const snapshot = controller.snapshot();
  assert.equal(snapshot.cursor, 1);
  assert.deepEqual(snapshot.events.map(event => event.sourceInstanceId), ['instance-a', 'instance-b']);
  await controller.close();
});

test('an endpoint reconfiguration discards an in-flight stale poll before storing its events', async () => {
  const client = new FakeClient();
  client.pauseFirstSessionList = Promise.withResolvers();
  client.pages.push({
    earliestCursor: 1,
    latestCursor: 1,
    gap: false,
    events: [taskEvent(1, 'task-completed')],
  });
  const controller = createTaskManagerController(config(), {
    createClient: () => client,
  });
  const stalePoll = controller.pollNow();
  await client.firstSessionListStarted.promise;
  controller.configure({ ...config(), markerPath: 'C:\\replacement-task-manager.json' });
  client.pauseFirstSessionList.resolve();
  await stalePoll;
  await waitUntil(() => controller.snapshot().cursor === 1);
  const snapshot = controller.snapshot();
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].sourceInstanceId, 'instance-a');
  assert.doesNotMatch(JSON.stringify(snapshot.events), /undefined/);
  await controller.close();
});

test('Task Manager controller validates and submits one exact routed command', async () => {
  const client = new FakeClient();
  const controller = createTaskManagerController(config(), {
    createClient: () => client,
  });
  const command = await controller.submitCommand({
    commandId: 'task-command:interaction-1',
    sessionId: 'session-a',
    text: '继续完成最后请求',
    mode: 'submit',
    contextRevision: 7,
  });
  assert.equal(command.status, 'observing');
  assert.deepEqual(client.commands, [{
    commandId: 'task-command:interaction-1',
    sessionId: 'session-a',
    text: '继续完成最后请求',
    mode: 'submit',
    contextRevision: 7,
  }]);
  await assert.rejects(controller.submitCommand({
    commandId: 'bad',
    sessionId: 'session-a',
    text: 'bad',
    mode: 'submit',
    contextRevision: 7,
    target: 'not-allowed',
  }), /unknown fields/);
  await controller.close();
});

test('managed Task Manager starts by default and can be disabled and restarted at runtime', async () => {
  const client = new FakeClient();
  const processes = [];
  const controller = createTaskManagerController({
    ...config(),
    lifecycle: 'managed',
    sessionMonitorMarkerPath: 'C:\\session_monitor.json',
    stateDirectory: 'C:\\DesktopChar\\task-manager',
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
    restartOnFailure: true,
  }, {
    createClient: () => client,
    launchManagedProcess: async () => {
      const exited = Promise.withResolvers();
      const process = {
        pid: 1_000 + processes.length,
        exited: exited.promise,
        exitInfo: undefined,
        closeCalls: 0,
        async close() {
          this.closeCalls++;
          const info = { code: 0, signal: null, stdoutTail: '', stderrTail: '' };
          this.exitInfo = info;
          exited.resolve(info);
          return info;
        },
      };
      processes.push(process);
      return process;
    },
  });

  await controller.start();
  assert.equal(controller.snapshot().phase, 'ready');
  assert.equal(controller.snapshot().lifecycle, 'managed');
  assert.equal(controller.snapshot().processId, 1_000);
  assert.equal(controller.snapshot().sessions.length, 1);

  await controller.setEnabled(false);
  assert.equal(controller.snapshot().enabled, false);
  assert.equal(controller.snapshot().phase, 'disabled');
  assert.equal(controller.snapshot().processId, null);
  assert.equal(controller.snapshot().sessions.length, 0);
  assert.equal(processes[0].closeCalls, 1);

  await controller.setEnabled(true);
  assert.equal(controller.snapshot().enabled, true);
  assert.equal(controller.snapshot().phase, 'ready');
  assert.equal(controller.snapshot().processId, 1_001);
  assert.equal(processes.length, 2);
  await controller.close();
});

test('healthy polling keeps the ready phase instead of flashing reconnecting', async () => {
  const client = new FakeClient();
  const phases = [];
  const controller = createTaskManagerController(config(), {
    createClient: () => client,
    onStateChanged: state => phases.push(state.phase),
  });
  await controller.pollNow();
  phases.length = 0;
  await controller.pollNow();
  assert.deepEqual(phases, ['ready']);
  await controller.close();
});

test('a failed poll invalidates stale sessions until the connection recovers', async () => {
  const client = new FakeClient();
  const controller = createTaskManagerController(config(), {
    createClient: () => client,
  });
  await controller.pollNow();
  assert.equal(controller.snapshot().sessions.length, 1);

  client.sessionListFailures = 1;
  await assert.rejects(controller.pollNow(), /simulated Task Manager disconnect/);
  assert.equal(controller.snapshot().phase, 'reconnecting');
  assert.equal(controller.snapshot().reconnectAttempt, 1);
  assert.equal(controller.snapshot().sessions.length, 0);

  await controller.pollNow();
  assert.equal(controller.snapshot().phase, 'ready');
  assert.equal(controller.snapshot().reconnectAttempt, 0);
  assert.equal(controller.snapshot().sessions.length, 1);
  await controller.close();
});

class FakeClient {
  instanceId = 'instance-a';
  pages = [];
  acked = [];
  commands = [];
  ackFailures = 0;
  pauseFirstSessionList;
  firstSessionListStarted = Promise.withResolvers();
  sessionListCalls = 0;
  sessionListFailures = 0;

  async discover() {
    return {
      markerPath: 'C:\\task_manager.json',
      instanceId: this.instanceId,
      baseUrl: 'http://127.0.0.1:1234/',
    };
  }

  async listSessions() {
    this.sessionListCalls++;
    if (this.sessionListFailures > 0) {
      this.sessionListFailures--;
      throw new Error('simulated Task Manager disconnect');
    }
    if (this.sessionListCalls === 1 && this.pauseFirstSessionList) {
      this.firstSessionListStarted.resolve();
      await this.pauseFirstSessionList.promise;
    }
    return [{
      sessionId: 'session-a',
      state: 'running',
      monitorState: 'observed',
      agentState: 'waiting_input',
      title: '测试会话',
      workDir: 'C:\\workspace',
      lastVisibleNonEmptyLine: '> ',
      lastScreenChangedAtUtc: '2026-07-29T10:00:00Z',
    }];
  }

  async eventsAfter() {
    return this.pages.shift() ?? {
      earliestCursor: 1,
      latestCursor: 0,
      gap: false,
      events: [],
    };
  }

  async ackEvent(eventId) {
    if (this.ackFailures > 0) {
      this.ackFailures--;
      throw new Error('ack failed');
    }
    this.acked.push(eventId);
    return { eventId };
  }

  async submitCommand(command) {
    this.commands.push(structuredClone(command));
    return { ...command, submissionGeneration: 1, status: 'observing' };
  }
}

function config() {
  return {
    enabled: true,
    markerPath: 'C:\\task_manager.json',
    pollIntervalMs: 60_000,
    requestTimeoutMs: 5_000,
    eventPageSize: 100,
    maxEvents: 20,
  };
}

function taskEvent(cursor, type) {
  return {
    eventId: `event-${cursor}`,
    cursor,
    sessionId: 'session-a',
    type,
    observedAtMs: 1_000 + cursor,
    status: type === 'task-completed' ? 'completed' : 'failed',
    submissionGeneration: cursor,
    title: '测试会话',
    lastVisibleLine: '完成',
    visibleTextTail: '完成',
  };
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Condition was not reached');
}
