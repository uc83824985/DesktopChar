import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export function createTaskManagerRuntime(options) {
  if (!options?.monitor) throw new TypeError('Task Manager requires a Session Monitor client');
  const monitor = options.monitor;
  const stableWaitingPolls = boundedInteger(
    options.stableWaitingPolls,
    2,
    2,
    10,
    'stableWaitingPolls',
  );
  const maxEvents = boundedInteger(options.maxEvents, 500, 10, 10_000, 'maxEvents');
  const maxCommands = boundedInteger(options.maxCommands, 500, 10, 10_000, 'maxCommands');
  const maxVisibleTextTailChars = boundedInteger(
    options.maxVisibleTextTailChars,
    4_000,
    100,
    12_000,
    'maxVisibleTextTailChars',
  );
  const activationTimeoutMs = boundedInteger(
    options.activationTimeoutMs,
    15_000,
    1_000,
    120_000,
    'activationTimeoutMs',
  );
  const allowedArtifactRoots = (options.allowedArtifactRoots ?? []).map(root =>
    path.resolve(nonEmptyText(root, 'allowed artifact root')));
  const fileSystem = options.fileSystem ?? { realpath, stat };
  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? (cursor => `task-event-${cursor}`);
  const sessions = new Map();
  const sessionFacts = new Map();
  const generations = new Map();
  const observations = new Map();
  const commands = new Map();
  const commandOrder = [];
  const events = [];
  let cursor = 0;
  let polling = false;
  let timer;
  let pollIntervalMs;
  let lastPollAtMs;
  let lastError;
  let closed = false;

  return {
    start,
    close,
    pollOnce,
    submitCommand,
    listSessions,
    eventsAfter,
    ackEvent,
    getSnapshot,
  };

  async function start() {
    ensureOpen();
    const discovery = await monitor.discover();
    pollIntervalMs = Math.max(discovery.intervalMs, options.pollIntervalMs ?? 0);
    await pollOnce();
    if (!timer) {
      timer = setInterval(() => {
        void pollOnce().catch(() => {});
      }, pollIntervalMs);
      timer.unref?.();
    }
    return getSnapshot();
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  async function pollOnce() {
    ensureOpen();
    if (polling) return getSnapshot();
    polling = true;
    try {
      const latest = await monitor.listSessions({ full: true });
      const currentIds = new Set();
      for (const rawSession of latest) {
        const session = normalizeSession(rawSession);
        currentIds.add(session.sessionId);
        sessions.set(session.sessionId, session);
        await observeSession(session);
      }
      for (const [sessionId, observation] of observations) {
        if (currentIds.has(sessionId)) continue;
        await settleUnavailable(observation, 'Session is no longer reported by Session Monitor');
      }
      lastPollAtMs = now();
      lastError = undefined;
      return getSnapshot();
    }
    catch (error) {
      lastError = errorMessage(error);
      throw error;
    }
    finally {
      polling = false;
    }
  }

  async function submitCommand(input) {
    ensureOpen();
    const command = await validateCommand(input);
    const existing = commands.get(command.commandId);
    if (existing) {
      if (!sameCommand(existing, command)) {
        throw new TaskManagerError(
          'idempotency-conflict',
          `Command ${command.commandId} was already used with a different payload`,
        );
      }
      return cloneCommand(existing);
    }

    const generation = nextGeneration(command.sessionId);
    generations.set(command.sessionId, generation);
    const record = createCommandRecord(command, generation, 'submitting');
    saveCommand(record);
    let detail;
    try {
      detail = normalizeSession(await monitor.getSession(command.sessionId));
      sessions.set(detail.sessionId, detail);
    }
    catch (error) {
      record.status = error?.code === 'session-unavailable' ? 'unavailable' : 'failed';
      record.completedAtMs = now();
      record.error = errorMessage(error);
      emitTaskEvent(
        record.status === 'unavailable' ? 'task-unavailable' : 'task-failed',
        record,
        undefined,
        record.status,
        record.error,
      );
      return cloneCommand(record);
    }
    if (detail.state !== 'running') {
      record.status = 'unavailable';
      record.completedAtMs = now();
      record.error = `Session ${command.sessionId} is ${detail.state}`;
      emitTaskEvent('task-unavailable', record, detail, 'unavailable', record.error);
      return cloneCommand(record);
    }

    let submission;
    try {
      submission = await monitor.submitInput(command.sessionId, command.text);
    }
    catch (error) {
      record.status = 'failed';
      record.completedAtMs = now();
      record.error = errorMessage(error);
      emitTaskEvent('task-failed', record, detail, 'failed', record.error);
      return cloneCommand(record);
    }

    if (generations.get(command.sessionId) !== generation) {
      record.status = 'superseded';
      return cloneCommand(record);
    }
    const previous = observations.get(command.sessionId);
    if (previous) {
      const previousCommand = commands.get(previous.commandId);
      if (previousCommand?.status === 'observing') previousCommand.status = 'superseded';
    }
    record.status = 'observing';
    record.submittedAtMs = now();
    record.beforeVisibleTextHash = detail.lastVisibleTextHash;
    record.beforeScreenChangedAtUtc = detail.lastScreenChangedAtUtc;
    observations.set(command.sessionId, {
      sessionId: command.sessionId,
      commandId: command.commandId,
      generation,
      beforeVisibleTextHash: detail.lastVisibleTextHash,
      beforeScreenChangedAtUtc: detail.lastScreenChangedAtUtc,
      observedActive:
        detail.agentState === 'active' || submission?.agentState === 'active',
      observedChange: false,
      stableWaitingCount: 0,
      lastWaitingFingerprint: undefined,
    });
    sessionFacts.set(command.sessionId, sessionFingerprint(detail));
    return cloneCommand(record);
  }

  function listSessions() {
    return [...sessions.values()]
      .map(cloneSession)
      .sort((left, right) =>
        (right.lastObservedAtUtc ?? '').localeCompare(left.lastObservedAtUtc ?? '')
        || left.sessionId.localeCompare(right.sessionId));
  }

  function eventsAfter(after = 0, limit = 100) {
    const normalizedAfter = nonNegativeInteger(after, 'event cursor');
    const normalizedLimit = boundedInteger(limit, 100, 1, 1_000, 'event limit');
    const earliestCursor = events[0]?.cursor ?? cursor + 1;
    return {
      requestedAfter: normalizedAfter,
      earliestCursor,
      latestCursor: cursor,
      gap: events.length > 0 && normalizedAfter < earliestCursor - 1,
      events: events
        .filter(event => event.cursor > normalizedAfter)
        .slice(0, normalizedLimit)
        .map(cloneEvent),
    };
  }

  function ackEvent(eventId) {
    const normalizedEventId = nonEmptyText(eventId, 'eventId');
    const event = events.find(item => item.eventId === normalizedEventId);
    if (!event) throw new TaskManagerError('event-not-found', `Event ${normalizedEventId} was not found`);
    if (event.acknowledgedAtMs === undefined) event.acknowledgedAtMs = now();
    return cloneEvent(event);
  }

  function getSnapshot() {
    return {
      phase: closed ? 'closed' : timer ? 'running' : 'standby',
      pollIntervalMs,
      lastPollAtMs,
      lastError,
      latestCursor: cursor,
      sessionCount: sessions.size,
      activeObservationCount: observations.size,
      sessions: listSessions(),
      commands: commandOrder.map(commandId => cloneCommand(commands.get(commandId))),
    };
  }

  async function observeSession(session) {
    const previousFingerprint = sessionFacts.get(session.sessionId);
    const nextFingerprint = sessionFingerprint(session);
    const observation = observations.get(session.sessionId);
    if (observation) {
      if (session.state !== 'running') {
        await settleUnavailable(observation, `Session became ${session.state}`, session);
      }
      else {
        await advanceObservation(observation, session);
      }
      sessionFacts.set(session.sessionId, nextFingerprint);
      return;
    }
    if (previousFingerprint !== undefined && previousFingerprint !== nextFingerprint) {
      emitSessionEvent(session);
    }
    sessionFacts.set(session.sessionId, nextFingerprint);
  }

  async function advanceObservation(observation, session) {
    const changed = changedAfterSubmission(observation, session);
    if (changed) observation.observedChange = true;
    if (session.agentState === 'active') observation.observedActive = true;
    const command = commands.get(observation.commandId);
    if (!command || command.status !== 'observing') {
      observations.delete(observation.sessionId);
      return;
    }
    if (!observation.observedActive) {
      observation.stableWaitingCount = 0;
      observation.lastWaitingFingerprint = undefined;
      if (now() - command.submittedAtMs >= activationTimeoutMs) {
        command.status = 'failed';
        command.completedAtMs = now();
        command.error =
          `Session did not enter active state within ${activationTimeoutMs} ms after submission`;
        emitTaskEvent('task-failed', command, session, 'failed', command.error);
        observations.delete(observation.sessionId);
      }
      return;
    }
    if (!observation.observedChange || session.agentState !== 'waiting_input') {
      observation.stableWaitingCount = 0;
      observation.lastWaitingFingerprint = undefined;
      return;
    }
    const waitingFingerprint = [
      session.lastVisibleTextHash ?? '',
      session.lastScreenChangedAtUtc ?? '',
      session.agentState,
    ].join('|');
    if (observation.lastWaitingFingerprint === waitingFingerprint) {
      observation.stableWaitingCount++;
    }
    else {
      observation.lastWaitingFingerprint = waitingFingerprint;
      observation.stableWaitingCount = 1;
    }
    if (observation.stableWaitingCount < stableWaitingPolls) return;

    const artifact = command.resultArtifact;
    if (artifact) {
      try {
        await validateArtifactPath(artifact.path, true);
      }
      catch (error) {
        command.status = 'failed';
        command.completedAtMs = now();
        command.error = errorMessage(error);
        emitTaskEvent('task-failed', command, session, 'failed', command.error);
        observations.delete(observation.sessionId);
        return;
      }
    }
    command.status = 'completed';
    command.completedAtMs = now();
    command.result = {
      sessionId: command.sessionId,
      submissionGeneration: command.submissionGeneration,
      status: 'completed',
      ...(session.title ? { title: session.title } : {}),
      ...(session.lastVisibleNonEmptyLine
        ? { lastVisibleLine: boundedTail(session.lastVisibleNonEmptyLine, 500) }
        : {}),
      ...(session.lastVisibleText
        ? { visibleTextTail: boundedTail(session.lastVisibleText, maxVisibleTextTailChars) }
        : {}),
      ...(artifact
        ? {
            resultArtifactPath: artifact.path,
            openArtifactOnCompletion: artifact.openOnCompletion,
          }
        : {}),
    };
    emitTaskEvent('task-completed', command, session, 'completed');
    observations.delete(observation.sessionId);
  }

  async function settleUnavailable(observation, reason, session = sessions.get(observation.sessionId)) {
    const command = commands.get(observation.commandId);
    if (command?.status === 'observing') {
      command.status = 'unavailable';
      command.completedAtMs = now();
      command.error = reason;
      emitTaskEvent('task-unavailable', command, session, 'unavailable', reason);
    }
    observations.delete(observation.sessionId);
  }

  function emitSessionEvent(session) {
    appendEvent({
      sessionId: session.sessionId,
      type: 'session-changed',
      observedAtMs: now(),
      status: sessionStatus(session),
      sourceHash: session.lastVisibleTextHash,
      sourceRevision: session.lastScreenChangedAtUtc,
      ...(session.title ? { title: session.title } : {}),
      ...(session.lastVisibleNonEmptyLine
        ? { lastVisibleLine: boundedTail(session.lastVisibleNonEmptyLine, 500) }
        : {}),
      ...(session.lastVisibleText
        ? { visibleTextTail: boundedTail(session.lastVisibleText, maxVisibleTextTailChars) }
        : {}),
    });
  }

  function emitTaskEvent(type, command, session, status, error) {
    appendEvent({
      sessionId: command.sessionId,
      type,
      observedAtMs: now(),
      status,
      submissionGeneration: command.submissionGeneration,
      commandId: command.commandId,
      sourceHash: session?.lastVisibleTextHash,
      sourceRevision: session?.lastScreenChangedAtUtc,
      ...(session?.title ? { title: session.title } : {}),
      ...(session?.lastVisibleNonEmptyLine
        ? { lastVisibleLine: boundedTail(session.lastVisibleNonEmptyLine, 500) }
        : {}),
      ...(session?.lastVisibleText
        ? { visibleTextTail: boundedTail(session.lastVisibleText, maxVisibleTextTailChars) }
        : {}),
      ...(command.resultArtifact && status === 'completed'
        ? {
            resultArtifactPath: command.resultArtifact.path,
            openArtifactOnCompletion: command.resultArtifact.openOnCompletion,
          }
        : {}),
      ...(error ? { error } : {}),
    });
  }

  function appendEvent(value) {
    const nextCursor = ++cursor;
    const event = {
      eventId: idFactory(nextCursor),
      cursor: nextCursor,
      ...withoutUndefined(value),
    };
    events.push(event);
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
  }

  async function validateCommand(value) {
    if (!record(value)) throw new TaskManagerError('invalid-command', 'Task command must be an object');
    exactKeys(
      value,
      ['commandId', 'sessionId', 'text', 'mode', 'contextRevision', 'resultArtifact'],
      'Task command',
    );
    if (value.mode !== 'submit') {
      throw new TaskManagerError('invalid-command', 'Task command mode must be submit');
    }
    const result = {
      commandId: nonEmptyText(value.commandId, 'commandId'),
      sessionId: nonEmptyText(value.sessionId, 'sessionId'),
      text: nonEmptyText(value.text, 'command text', false),
      mode: 'submit',
      contextRevision: nonNegativeInteger(value.contextRevision, 'contextRevision'),
    };
    if (value.resultArtifact !== undefined) {
      if (!record(value.resultArtifact)) {
        throw new TaskManagerError('invalid-command', 'resultArtifact must be an object');
      }
      exactKeys(value.resultArtifact, ['path', 'openOnCompletion'], 'resultArtifact');
      if (typeof value.resultArtifact.openOnCompletion !== 'boolean') {
        throw new TaskManagerError(
          'invalid-command',
          'resultArtifact.openOnCompletion must be a boolean',
        );
      }
      const artifactPath = await validateArtifactPath(value.resultArtifact.path, false);
      result.resultArtifact = {
        path: artifactPath,
        openOnCompletion: value.resultArtifact.openOnCompletion,
      };
    }
    return result;
  }

  async function validateArtifactPath(value, requireFile) {
    const declaredPath = nonEmptyText(value, 'resultArtifact.path');
    if (!path.isAbsolute(declaredPath)) {
      throw new TaskManagerError('artifact-path-rejected', 'Result artifact path must be absolute');
    }
    const resolved = path.resolve(declaredPath);
    const lexicalRoot = allowedArtifactRoots.find(root => isWithin(root, resolved));
    if (!lexicalRoot) {
      throw new TaskManagerError(
        'artifact-path-rejected',
        'Result artifact path is outside the configured allowed roots',
      );
    }
    let realRoot;
    try {
      realRoot = await fileSystem.realpath(lexicalRoot);
    }
    catch (error) {
      throw new TaskManagerError(
        'artifact-path-rejected',
        `Allowed artifact root is unavailable: ${lexicalRoot}`,
        { cause: error },
      );
    }
    const ancestor = await nearestExistingPath(resolved, fileSystem.stat);
    const realAncestor = await fileSystem.realpath(ancestor);
    if (!isWithin(realRoot, realAncestor)) {
      throw new TaskManagerError(
        'artifact-path-rejected',
        'Result artifact path escapes its allowed root',
      );
    }
    if (requireFile) {
      let fileStats;
      try {
        fileStats = await fileSystem.stat(resolved);
      }
      catch (error) {
        throw new TaskManagerError(
          'artifact-missing',
          `Declared result artifact does not exist: ${resolved}`,
          { cause: error },
        );
      }
      if (!fileStats.isFile()) {
        throw new TaskManagerError(
          'artifact-missing',
          `Declared result artifact is not a file: ${resolved}`,
        );
      }
      const realFile = await fileSystem.realpath(resolved);
      if (!isWithin(realRoot, realFile)) {
        throw new TaskManagerError(
          'artifact-path-rejected',
          'Resolved result artifact escapes its allowed root',
        );
      }
    }
    return resolved;
  }

  function nextGeneration(sessionId) {
    return (generations.get(sessionId) ?? 0) + 1;
  }

  function createCommandRecord(command, generation, status) {
    return {
      ...cloneCommandInput(command),
      submissionGeneration: generation,
      status,
      createdAtMs: now(),
    };
  }

  function saveCommand(command) {
    commands.set(command.commandId, command);
    commandOrder.push(command.commandId);
    if (commandOrder.length > maxCommands) {
      const removed = commandOrder.splice(0, commandOrder.length - maxCommands);
      for (const commandId of removed) {
        if (![...observations.values()].some(item => item.commandId === commandId)) {
          commands.delete(commandId);
        }
      }
    }
  }

  function ensureOpen() {
    if (closed) throw new TaskManagerError('closed', 'Task Manager is closed');
  }
}

export class TaskManagerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'TaskManagerError';
    this.code = code;
  }
}

function normalizeSession(value) {
  if (!record(value)) throw new TaskManagerError('invalid-monitor-data', 'Session must be an object');
  return {
    sessionId: nonEmptyText(value.sessionId, 'session.sessionId'),
    state: enumText(value.state, ['running', 'exited', 'closed', 'stale'], 'session.state'),
    monitorState: enumText(
      value.monitorState,
      ['pending', 'observed', 'unreadable', 'closed'],
      'session.monitorState',
    ),
    agentState: enumText(
      value.agentState,
      ['waiting_input', 'active', 'idle_unknown', 'unknown', 'closed'],
      'session.agentState',
    ),
    title: optionalText(value.title),
    workDir: optionalText(value.workDir),
    lastVisibleText: optionalText(value.lastVisibleText, true),
    lastVisibleNonEmptyLine: optionalText(value.lastVisibleNonEmptyLine, true),
    lastVisibleTextHash: optionalText(value.lastVisibleTextHash),
    lastScreenChangedAtUtc: optionalText(value.lastScreenChangedAtUtc),
    lastObservedAtUtc: optionalText(value.lastObservedAtUtc),
  };
}

function changedAfterSubmission(observation, session) {
  if (
    session.lastVisibleTextHash
    && session.lastVisibleTextHash !== observation.beforeVisibleTextHash
  ) return true;
  return compareUtc(session.lastScreenChangedAtUtc, observation.beforeScreenChangedAtUtc) > 0;
}

function sessionFingerprint(session) {
  return [
    session.state,
    session.monitorState,
    session.agentState,
    session.lastVisibleTextHash ?? '',
    session.lastScreenChangedAtUtc ?? '',
  ].join('|');
}

function sessionStatus(session) {
  if (session.state !== 'running') return 'unavailable';
  return session.agentState.replaceAll('_', '-');
}

function compareUtc(left, right) {
  if (!left) return 0;
  if (!right) return 1;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return left.localeCompare(right);
  return leftMs - rightMs;
}

async function nearestExistingPath(filePath, statImpl) {
  let candidate = filePath;
  while (true) {
    try {
      await statImpl(candidate);
      return candidate;
    }
    catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) throw new TaskManagerError(
        'artifact-path-rejected',
        `No existing ancestor was found for ${filePath}`,
      );
      candidate = parent;
    }
  }
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sameCommand(existing, command) {
  return existing.commandId === command.commandId
    && existing.sessionId === command.sessionId
    && existing.text === command.text
    && existing.mode === command.mode
    && existing.contextRevision === command.contextRevision
    && JSON.stringify(existing.resultArtifact) === JSON.stringify(command.resultArtifact);
}

function cloneCommandInput(command) {
  return {
    commandId: command.commandId,
    sessionId: command.sessionId,
    text: command.text,
    mode: command.mode,
    contextRevision: command.contextRevision,
    ...(command.resultArtifact
      ? { resultArtifact: { ...command.resultArtifact } }
      : {}),
  };
}

function cloneCommand(command) {
  if (!command) return undefined;
  return {
    ...command,
    ...(command.resultArtifact ? { resultArtifact: { ...command.resultArtifact } } : {}),
    ...(command.result ? { result: { ...command.result } } : {}),
  };
}

function cloneSession(session) {
  return { ...session };
}

function cloneEvent(event) {
  return { ...event };
}

function boundedTail(value, maximum) {
  return value.length <= maximum ? value : value.slice(value.length - maximum);
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  const allowed = new Set(expected);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) {
    throw new TaskManagerError('invalid-command', `${label} contains unknown field ${unknown[0]}`);
  }
}

function enumText(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TaskManagerError('invalid-monitor-data', `${label} is invalid`);
  }
  return value;
}

function nonEmptyText(value, label, trim = true) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TaskManagerError('invalid-command', `${label} must be a non-empty string`);
  }
  return trim ? value.trim() : value;
}

function optionalText(value, preserveWhitespace = false) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return preserveWhitespace ? value : value.trim();
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TaskManagerError('invalid-command', `${label} must be a non-negative integer`);
  }
  return value;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return result;
}
