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

class FakeClient {
  instanceId = 'instance-a';
  pages = [];
  acked = [];
  ackFailures = 0;

  async discover() {
    return {
      markerPath: 'C:\\task_manager.json',
      instanceId: this.instanceId,
      baseUrl: 'http://127.0.0.1:1234/',
    };
  }

  async listSessions() {
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
