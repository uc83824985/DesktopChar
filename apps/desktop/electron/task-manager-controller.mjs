import { createTaskManagerClient } from './task-manager-client.mjs';

export function createTaskManagerController(initialConfig, options = {}) {
  const createClient = options.createClient ?? (config =>
    createTaskManagerClient({
      markerPath: config.markerPath,
      requestTimeoutMs: config.requestTimeoutMs,
    }));
  const onStateChanged = options.onStateChanged ?? (() => {});
  let config = normalizeConfig(initialConfig);
  let client;
  let timer;
  let polling;
  let closed = false;
  let instanceId;
  let cursor = 0;
  let sessions = [];
  let events = [];
  let pendingAckIds = new Set();
  let phase = config.enabled ? 'standby' : 'disabled';
  let lastError;
  let lastPollAtMs;

  return {
    start,
    close,
    configure,
    pollNow,
    submitCommand,
    snapshot,
  };

  async function start() {
    if (closed) throw new Error('Task Manager controller is closed');
    if (!config.enabled) {
      phase = 'disabled';
      publish();
      return snapshot();
    }
    schedule();
    await pollNow().catch(() => {});
    return snapshot();
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    phase = 'closed';
    publish();
  }

  function configure(nextConfig) {
    const next = normalizeConfig(nextConfig);
    const endpointChanged = config.markerPath !== next.markerPath
      || config.requestTimeoutMs !== next.requestTimeoutMs;
    const intervalChanged = config.pollIntervalMs !== next.pollIntervalMs;
    config = next;
    if (endpointChanged) {
      client = undefined;
      instanceId = undefined;
      cursor = 0;
      pendingAckIds = new Set();
    }
    if (!config.enabled) {
      if (timer) clearInterval(timer);
      timer = undefined;
      phase = 'disabled';
      lastError = undefined;
      publish();
      return;
    }
    if (intervalChanged || !timer) schedule();
    void pollNow().catch(() => {});
  }

  async function pollNow() {
    if (closed || !config.enabled) return snapshot();
    if (polling) return polling;
    polling = performPoll().finally(() => { polling = undefined; });
    return polling;
  }

  async function submitCommand(input) {
    if (closed) throw new Error('Task Manager controller is closed');
    if (!config.enabled) throw new Error('Task Manager is disabled');
    const command = normalizeCommand(input);
    client ??= createClient(config);
    await client.discover();
    const result = await client.submitCommand(command);
    void pollNow().catch(() => {});
    return result;
  }

  async function performPoll() {
    phase = instanceId ? 'reconnecting' : 'connecting';
    publish();
    try {
      client ??= createClient(config);
      const discovery = await client.discover();
      if (instanceId !== discovery.instanceId) {
        instanceId = discovery.instanceId;
        cursor = 0;
        pendingAckIds = new Set();
      }
      let degradedError;
      await retryAcks();
      sessions = (await client.listSessions()).map(normalizeSession);
      const page = await client.eventsAfter(cursor, config.eventPageSize);
      if (page.gap) {
        degradedError = `Task Manager event cursor gap before ${page.earliestCursor}`;
      }
      for (const rawEvent of page.events) {
        const event = normalizeEvent(rawEvent, instanceId);
        if (event.cursor <= cursor) continue;
        const identity = eventIdentity(event);
        if (!events.some(existing => eventIdentity(existing) === identity)) {
          events.push(event);
          if (events.length > config.maxEvents) {
            events.splice(0, events.length - config.maxEvents);
          }
        }
        cursor = event.cursor;
        pendingAckIds.add(event.eventId);
      }
      try {
        await retryAcks();
      }
      catch (error) {
        degradedError = errorMessage(error);
      }
      lastPollAtMs = Date.now();
      lastError = degradedError;
      phase = degradedError ? 'degraded' : 'ready';
      publish();
      return snapshot();
    }
    catch (error) {
      phase = 'reconnecting';
      lastError = errorMessage(error);
      publish();
      throw error;
    }
  }

  async function retryAcks() {
    for (const eventId of [...pendingAckIds]) {
      await client.ackEvent(eventId);
      pendingAckIds.delete(eventId);
    }
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      void pollNow().catch(() => {});
    }, config.pollIntervalMs);
    timer.unref?.();
  }

  function snapshot() {
    return {
      enabled: config.enabled,
      phase,
      markerPath: config.markerPath,
      instanceId: instanceId ?? null,
      cursor,
      pendingAckCount: pendingAckIds.size,
      lastPollAtMs: lastPollAtMs ?? null,
      lastError: lastError ?? null,
      sessions: sessions.map(item => ({ ...item })),
      events: events.map(item => ({ ...item })),
    };
  }

  function publish() {
    onStateChanged(snapshot());
  }
}

function normalizeConfig(value = {}) {
  const enabled = value.enabled === true;
  const markerPath = typeof value.markerPath === 'string' ? value.markerPath.trim() : '';
  if (enabled && !markerPath) throw new TypeError('Enabled Task Manager requires markerPath');
  return {
    enabled,
    markerPath,
    pollIntervalMs: boundedInteger(value.pollIntervalMs, 1_000, 250, 60_000, 'pollIntervalMs'),
    requestTimeoutMs: boundedInteger(
      value.requestTimeoutMs,
      5_000,
      100,
      60_000,
      'requestTimeoutMs',
    ),
    eventPageSize: boundedInteger(value.eventPageSize, 100, 1, 1_000, 'eventPageSize'),
    maxEvents: boundedInteger(value.maxEvents, 200, 10, 2_000, 'maxEvents'),
  };
}

function normalizeSession(value) {
  if (!record(value)) throw new TypeError('Task Manager session must be an object');
  return {
    sessionId: nonEmptyText(value.sessionId, 'Task Manager sessionId'),
    state: enumText(value.state, ['running', 'exited', 'closed', 'stale'], 'session state'),
    monitorState: enumText(
      value.monitorState,
      ['pending', 'observed', 'unreadable', 'closed'],
      'session monitorState',
    ),
    agentState: enumText(
      value.agentState,
      ['waiting_input', 'active', 'idle_unknown', 'unknown', 'closed'],
      'session agentState',
    ),
    ...(optionalText(value.title) ? { title: optionalText(value.title) } : {}),
    ...(optionalText(value.workDir) ? { workDir: optionalText(value.workDir) } : {}),
    ...(optionalText(value.lastVisibleNonEmptyLine, true)
      ? { lastVisibleLine: boundedTail(value.lastVisibleNonEmptyLine, 500) }
      : {}),
    ...(optionalText(value.lastScreenChangedAtUtc)
      ? { lastScreenChangedAtUtc: optionalText(value.lastScreenChangedAtUtc) }
      : {}),
  };
}

function normalizeCommand(value) {
  if (!record(value)) throw new TypeError('Task Manager command must be an object');
  exactKeys(
    value,
    ['commandId', 'sessionId', 'text', 'mode', 'contextRevision', 'resultArtifact'],
    'Task Manager command',
  );
  if (value.mode !== 'submit') throw new TypeError('Task Manager command mode must be submit');
  const result = {
    commandId: nonEmptyText(value.commandId, 'Task Manager commandId'),
    sessionId: nonEmptyText(value.sessionId, 'Task Manager command sessionId'),
    text: boundedText(value.text, 12_000, 'Task Manager command text'),
    mode: 'submit',
    contextRevision: nonNegativeInteger(
      value.contextRevision,
      'Task Manager command contextRevision',
    ),
  };
  if (value.resultArtifact !== undefined) {
    if (!record(value.resultArtifact)) {
      throw new TypeError('Task Manager resultArtifact must be an object');
    }
    exactKeys(
      value.resultArtifact,
      ['path', 'openOnCompletion'],
      'Task Manager resultArtifact',
    );
    if (typeof value.resultArtifact.openOnCompletion !== 'boolean') {
      throw new TypeError('Task Manager resultArtifact.openOnCompletion must be boolean');
    }
    result.resultArtifact = {
      path: nonEmptyText(value.resultArtifact.path, 'Task Manager resultArtifact.path'),
      openOnCompletion: value.resultArtifact.openOnCompletion,
    };
  }
  return result;
}

function normalizeEvent(value, instanceId) {
  if (!record(value)) throw new TypeError('Task Manager event must be an object');
  const type = enumText(
    value.type,
    ['session-changed', 'task-completed', 'task-failed', 'task-unavailable'],
    'Task Manager event type',
  );
  return {
    sourceInstanceId: instanceId,
    eventId: nonEmptyText(value.eventId, 'Task Manager eventId'),
    cursor: positiveInteger(value.cursor, 'Task Manager event cursor'),
    sessionId: nonEmptyText(value.sessionId, 'Task Manager event sessionId'),
    type,
    observedAtMs: nonNegativeInteger(value.observedAtMs, 'Task Manager event observedAtMs'),
    status: nonEmptyText(value.status, 'Task Manager event status'),
    ...(Number.isInteger(value.submissionGeneration) && value.submissionGeneration > 0
      ? { submissionGeneration: value.submissionGeneration }
      : {}),
    ...(optionalText(value.commandId) ? { commandId: optionalText(value.commandId) } : {}),
    ...(optionalText(value.title) ? { title: boundedTail(value.title, 300) } : {}),
    ...(optionalText(value.lastVisibleLine, true)
      ? { lastVisibleLine: boundedTail(value.lastVisibleLine, 500) }
      : {}),
    ...(optionalText(value.visibleTextTail, true)
      ? { visibleTextTail: boundedTail(value.visibleTextTail, 4_000) }
      : {}),
    ...(optionalText(value.resultArtifactPath)
      ? { resultArtifactPath: optionalText(value.resultArtifactPath) }
      : {}),
    ...(typeof value.openArtifactOnCompletion === 'boolean'
      ? { openArtifactOnCompletion: value.openArtifactOnCompletion }
      : {}),
    ...(optionalText(value.error) ? { error: boundedTail(value.error, 500) } : {}),
  };
}

function eventIdentity(event) {
  return `${event.sourceInstanceId}:${event.eventId}`;
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function enumText(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function nonEmptyText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalText(value, preserveWhitespace = false) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return preserveWhitespace ? value : value.trim();
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be positive`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be non-negative`);
  }
  return value;
}

function boundedText(value, maximum, label) {
  const normalized = nonEmptyText(value, label);
  if (normalized.length > maximum) {
    throw new RangeError(`${label} must not exceed ${maximum} characters`);
  }
  return normalized;
}

function exactKeys(value, allowed, label) {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter(key => !allowedKeys.has(key));
  if (unknown.length > 0) throw new TypeError(`${label} contains unknown fields: ${unknown.join(', ')}`);
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return result;
}

function boundedTail(value, maximum) {
  return value.length <= maximum ? value : value.slice(value.length - maximum);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
