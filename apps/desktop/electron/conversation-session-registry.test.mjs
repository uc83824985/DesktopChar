import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationSessionRegistry } from './conversation-session-registry.mjs';

test('external conversation binding registers a discovered window and disconnects without closing it', async () => {
  const externalCommands = [];
  const watched = [];
  const unwatched = [];
  let stateChanges = 0;
  const registry = createConversationSessionRegistry({
    managedClient: new FakeManagedClient(),
    externalController: {
      async submitCommand(command) {
        externalCommands.push(structuredClone(command));
        return { ...command, submissionGeneration: 1, status: 'observing' };
      },
      async watchSession(sessionId) {
        watched.push(sessionId);
        return { sessionId, phase: 'waiting', turnSequence: 0 };
      },
      async unwatchSession(sessionId) {
        unwatched.push(sessionId);
        return { sessionId, removed: true };
      },
    },
    onStateChanged() {
      stateChanges++;
    },
  });
  registry.syncExternalSessions([externalSession('session-a', '现有对话窗口')]);
  registry.syncExternalSessions([externalSession('session-a', '现有对话窗口')]);
  assert.equal(stateChanges, 1);
  assert.equal(registry.snapshot().availableExternalSessions.length, 1);

  const bound = await registry.bindExternalSession({ sourceSessionId: 'session-a' });
  assert.equal(bound.sessionId, 'external:session-a');
  assert.equal(bound.ownership, 'external');
  assert.equal(registry.snapshot().availableExternalSessions.length, 0);
  assert.deepEqual(watched, ['session-a']);

  const submitted = await registry.submitCommand(command(bound.sessionId, '立即补充说明'));
  assert.equal(submitted.sessionId, bound.sessionId);
  assert.equal(submitted.sourceSessionId, 'session-a');
  assert.deepEqual(externalCommands, [command('session-a', '立即补充说明')]);

  const closed = await registry.closeSession(bound.sessionId);
  assert.deepEqual(closed, { sessionId: bound.sessionId, action: 'disconnected' });
  assert.deepEqual(unwatched, ['session-a']);
  assert.equal(registry.snapshot().sessions.length, 0);
  assert.equal(registry.snapshot().availableExternalSessions.length, 1);
  await registry.close();
});

test('managed conversation owns one persistent thread, steers active work, and archives on close', async () => {
  let clock = 1_000;
  const managed = new FakeManagedClient();
  const managedEvents = [];
  const registry = createConversationSessionRegistry({
    managedClient: managed,
    externalController: { submitCommand: async () => assert.fail('external submit is unexpected') },
    now: () => ++clock,
    onManagedEvent(event) {
      managedEvents.push(structuredClone(event));
    },
  });
  const created = await registry.createManagedSession({ title: '主应用托管对话' });
  assert.equal(created.sessionId, 'managed:thread-1');
  assert.equal(created.status, 'waiting-input');

  const first = await registry.submitCommand(command(created.sessionId, '开始任务'));
  assert.equal(first.delivery, 'turn-started');
  assert.equal(registry.snapshot().sessions[0].status, 'active');
  const second = await registry.submitCommand(command(created.sessionId, '改为只处理最后要求'));
  assert.equal(second.delivery, 'steered');
  assert.deepEqual(managed.steers, [{
    threadId: 'thread-1',
    text: '改为只处理最后要求',
  }]);

  managed.turns[0].completion.resolve('已完成最新要求');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(registry.snapshot().sessions[0].status, 'waiting-input');
  assert.equal(registry.snapshot().sessions[0].lastResponse, '已完成最新要求');
  assert.deepEqual(managedEvents, [{
    eventId: 'managed-event-1',
    sessionId: created.sessionId,
    type: 'task-completed',
    observedAtMs: 1_004,
    status: 'completed',
    title: '主应用托管对话',
    lastVisibleLine: '已完成最新要求',
    visibleTextTail: '已完成最新要求',
  }]);

  const closed = await registry.closeSession(created.sessionId);
  assert.deepEqual(closed, { sessionId: created.sessionId, action: 'archived' });
  assert.deepEqual(managed.archived, ['thread-1']);
  assert.equal(registry.snapshot().sessions.length, 0);
  await registry.close();
});

test('a missing external window remains registered as unavailable until the user disconnects it', async () => {
  const registry = createConversationSessionRegistry({
    managedClient: new FakeManagedClient(),
    externalController: {
      submitCommand: async () => assert.fail('submit is unexpected'),
      watchSession: async sessionId => ({ sessionId }),
      unwatchSession: async sessionId => ({ sessionId, removed: true }),
    },
  });
  registry.syncExternalSessions([externalSession('session-a', '会话 A')]);
  const bound = await registry.bindExternalSession({ sourceSessionId: 'session-a' });
  registry.syncExternalSessions([], {
    unavailableReason: 'Task Manager connection was interrupted',
  });
  const session = registry.snapshot().sessions[0];
  assert.equal(session.sessionId, bound.sessionId);
  assert.equal(session.status, 'unavailable');
  assert.equal(session.lastError, 'Task Manager connection was interrupted');
  await assert.rejects(
    registry.submitCommand(command(bound.sessionId, '不应发送')),
    /unavailable/,
  );
  registry.syncExternalSessions([externalSession('session-a', '会话 A')]);
  const recovered = registry.snapshot().sessions[0];
  assert.equal(recovered.status, 'waiting-input');
  assert.equal(recovered.lastError, null);
  await registry.closeSession(bound.sessionId);
  await registry.close();
});

class FakeManagedClient {
  threads = 0;
  turns = [];
  steers = [];
  archived = [];

  async createThread() {
    return { threadId: `thread-${++this.threads}` };
  }

  executeThread(threadId, request, _signal, hooks) {
    const completion = Promise.withResolvers();
    this.turns.push({ threadId, request, completion });
    queueMicrotask(() => hooks.onTurnStarted(`turn-${this.turns.length}`));
    return completion.promise;
  }

  async steerThread(threadId, text) {
    this.steers.push({ threadId, text });
    return { turnId: `turn-${this.turns.length}` };
  }

  async archiveThread(threadId) {
    this.archived.push(threadId);
  }
}

function externalSession(sessionId, title) {
  return {
    sessionId,
    title,
    workDir: 'C:\\workspace',
    state: 'running',
    monitorState: 'observed',
    agentState: 'waiting_input',
  };
}

function command(sessionId, text) {
  return {
    commandId: 'command-1',
    sessionId,
    text,
    mode: 'submit',
    contextRevision: 3,
  };
}
