import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskManagerHttpService } from './http-service.mjs';

test('Task Manager HTTP service exposes only authenticated narrow domain endpoints', async () => {
  const calls = [];
  const watches = [];
  const runtime = {
    getSnapshot: () => ({
      phase: 'running',
      lastPollAtMs: 1_000,
      lastError: undefined,
    }),
    listSessions: () => [{ sessionId: 'session-a', status: 'active' }],
    eventsAfter: (after, limit) => ({
      requestedAfter: after,
      earliestCursor: 2,
      latestCursor: 4,
      gap: false,
      events: [{ eventId: 'event-3', cursor: 3 }].slice(0, limit),
    }),
    async submitCommand(command) {
      calls.push(command);
      return { ...command, submissionGeneration: 1, status: 'observing' };
    },
    async watchSession(sessionId) {
      watches.push(['watch', sessionId]);
      return { sessionId, phase: 'waiting', turnSequence: 0 };
    },
    unwatchSession(sessionId) {
      watches.push(['unwatch', sessionId]);
      return { sessionId, removed: true };
    },
    ackEvent(eventId) {
      return { eventId, cursor: 3, acknowledgedAtMs: 2_000 };
    },
  };
  const service = createTaskManagerHttpService({
    runtime,
    token: 'task-manager-secret',
    port: 0,
  });
  const address = await service.listen();
  try {
    const health = await fetch(`${address.baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).role, 'desktop_char_task_manager');

    const unauthorized = await fetch(`${address.baseUrl}/sessions`);
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { ok: false, error: 'unauthorized' });

    const headers = {
      Authorization: 'Bearer task-manager-secret',
      'Content-Type': 'application/json; charset=utf-8',
    };
    const sessions = await fetch(`${address.baseUrl}/sessions`, { headers });
    assert.deepEqual(await sessions.json(), {
      ok: true,
      sessions: [{ sessionId: 'session-a', status: 'active' }],
    });
    const events = await fetch(`${address.baseUrl}/events?after=2&limit=5`, { headers });
    assert.deepEqual(await events.json(), {
      ok: true,
      requestedAfter: 2,
      earliestCursor: 2,
      latestCursor: 4,
      gap: false,
      events: [{ eventId: 'event-3', cursor: 3 }],
    });
    const command = {
      commandId: 'command-a',
      sessionId: 'session-a',
      text: '继续处理',
      mode: 'submit',
      contextRevision: 9,
    };
    const submitted = await fetch(`${address.baseUrl}/commands`, {
      method: 'POST',
      headers,
      body: JSON.stringify(command),
    });
    assert.equal(submitted.status, 202);
    assert.equal((await submitted.json()).command.status, 'observing');
    assert.deepEqual(calls, [command]);

    const watched = await fetch(`${address.baseUrl}/watches/session-a`, {
      method: 'PUT',
      headers,
    });
    assert.deepEqual((await watched.json()).watch, {
      sessionId: 'session-a',
      phase: 'waiting',
      turnSequence: 0,
    });
    const unwatched = await fetch(`${address.baseUrl}/watches/session-a`, {
      method: 'DELETE',
      headers,
    });
    assert.deepEqual((await unwatched.json()).watch, {
      sessionId: 'session-a',
      removed: true,
    });
    assert.deepEqual(watches, [
      ['watch', 'session-a'],
      ['unwatch', 'session-a'],
    ]);

    const ack = await fetch(`${address.baseUrl}/events/event-3/ack`, {
      method: 'POST',
      headers,
    });
    assert.equal((await ack.json()).event.acknowledgedAtMs, 2_000);
    const hiddenSurface = await fetch(`${address.baseUrl}/api/sessions/session-a/input`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(hiddenSurface.status, 404);
  }
  finally {
    await service.close();
  }
});

test('Task Manager HTTP service refuses non-loopback binding', () => {
  assert.throws(
    () => createTaskManagerHttpService({
      runtime: {},
      token: 'secret',
      host: '0.0.0.0',
    }),
    /loopback/,
  );
});
