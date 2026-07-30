export function createConversationSessionRegistry(options = {}) {
  const managedClient = options.managedClient;
  const externalController = options.externalController;
  const onStateChanged = options.onStateChanged ?? (() => {});
  const onManagedEvent = options.onManagedEvent ?? (() => {});
  const now = options.now ?? Date.now;
  if (!managedClient) throw new TypeError('Conversation session registry requires managedClient');
  if (!externalController) {
    throw new TypeError('Conversation session registry requires externalController');
  }
  const sessions = new Map();
  const externalCandidates = new Map();
  let managedSequence = 0;
  let managedEventSequence = 0;
  let revision = 0;
  let phase = 'ready';

  return {
    syncExternalSessions,
    createManagedSession,
    bindExternalSession,
    closeSession,
    submitCommand,
    snapshot,
    close,
  };

  function syncExternalSessions(values = [], options = {}) {
    if (phase === 'closed') return snapshot();
    const unavailableReason = normalizeExternalSyncOptions(options).unavailableReason;
    const previousSignature = externalSyncSignature();
    const nextCandidates = new Map();
    for (const value of values) {
      const candidate = normalizeExternalCandidate(value);
      nextCandidates.set(candidate.sourceSessionId, candidate);
    }
    externalCandidates.clear();
    for (const [sourceSessionId, candidate] of nextCandidates) {
      externalCandidates.set(sourceSessionId, candidate);
    }
    for (const session of sessions.values()) {
      if (session.ownership !== 'external') continue;
      const candidate = externalCandidates.get(session.sourceSessionId);
      if (!candidate) {
        session.status = 'unavailable';
        session.lastError = unavailableReason;
        continue;
      }
      session.title = candidate.title;
      session.workDir = candidate.workDir;
      session.status = candidate.status;
      session.lastError = candidate.status === 'unavailable'
        ? 'External conversation is unavailable'
        : null;
    }
    if (externalSyncSignature() !== previousSignature) publish();
    return snapshot();
  }

  async function createManagedSession(input = {}) {
    requireOpen();
    exactKeys(input, ['title'], 'Managed conversation request');
    const requestedTitle = optionalBoundedText(input.title, 120, 'Managed conversation title');
    const created = await managedClient.createThread();
    const threadId = nonEmptyText(created?.threadId, 'Managed conversation threadId');
    const sessionId = `managed:${threadId}`;
    if (sessions.has(sessionId)) {
      throw new Error(`Managed conversation is already registered: ${sessionId}`);
    }
    managedSequence++;
    const timestamp = now();
    const session = {
      sessionId,
      ownership: 'managed',
      threadId,
      title: requestedTitle ?? `Managed ${managedSequence}`,
      status: 'waiting-input',
      workDir: null,
      createdAtMs: timestamp,
      lastActivityAtMs: timestamp,
      lastResponse: null,
      lastError: null,
      activeOperation: null,
    };
    sessions.set(sessionId, session);
    publish();
    return publicSession(session);
  }

  async function bindExternalSession(input) {
    requireOpen();
    if (!record(input)) throw new TypeError('External conversation binding must be an object');
    exactKeys(input, ['sourceSessionId'], 'External conversation binding');
    const sourceSessionId = nonEmptyText(
      input.sourceSessionId,
      'External conversation sourceSessionId',
    );
    const candidate = externalCandidates.get(sourceSessionId);
    if (!candidate) {
      throw new Error(`External conversation is not currently discoverable: ${sourceSessionId}`);
    }
    const existing = [...sessions.values()].find(
      session => session.ownership === 'external' && session.sourceSessionId === sourceSessionId,
    );
    if (typeof externalController.watchSession !== 'function') {
      throw new Error('External conversation controller does not support passive observation');
    }
    await externalController.watchSession(sourceSessionId);
    if (existing) return publicSession(existing);
    const timestamp = now();
    const session = {
      sessionId: `external:${sourceSessionId}`,
      ownership: 'external',
      sourceSessionId,
      title: candidate.title,
      status: candidate.status,
      workDir: candidate.workDir,
      createdAtMs: timestamp,
      lastActivityAtMs: timestamp,
      lastResponse: null,
      lastError: candidate.status === 'unavailable'
        ? 'External conversation is unavailable'
        : null,
      activeOperation: null,
    };
    sessions.set(session.sessionId, session);
    publish();
    return publicSession(session);
  }

  async function closeSession(sessionId) {
    requireOpen();
    const normalizedSessionId = nonEmptyText(sessionId, 'Conversation sessionId');
    const session = sessions.get(normalizedSessionId);
    if (!session) throw new Error(`Conversation session is not registered: ${normalizedSessionId}`);
    if (session.ownership === 'external') {
      await Promise.resolve(
        externalController.unwatchSession?.(session.sourceSessionId),
      ).catch(() => {});
      sessions.delete(normalizedSessionId);
      publish();
      return { sessionId: normalizedSessionId, action: 'disconnected' };
    }
    session.status = 'unavailable';
    session.lastError = null;
    publish();
    try {
      await managedClient.archiveThread(session.threadId);
      sessions.delete(normalizedSessionId);
      publish();
      return { sessionId: normalizedSessionId, action: 'archived' };
    }
    catch (error) {
      session.lastError = errorMessage(error);
      publish();
      throw error;
    }
  }

  async function submitCommand(input) {
    requireOpen();
    const command = normalizeCommand(input);
    const session = sessions.get(command.sessionId);
    if (!session) {
      throw new Error(`Conversation session is not registered: ${command.sessionId}`);
    }
    if (session.status === 'unavailable') {
      throw new Error(`Conversation session is unavailable: ${command.sessionId}`);
    }
    if (session.ownership === 'external') {
      const result = await externalController.submitCommand({
        ...command,
        sessionId: session.sourceSessionId,
      });
      session.lastActivityAtMs = now();
      session.lastError = null;
      publish();
      return {
        ...result,
        sessionId: session.sessionId,
        sourceSessionId: session.sourceSessionId,
        ownership: 'external',
      };
    }
    return submitManagedCommand(session, command);
  }

  async function submitManagedCommand(session, command) {
    if (session.activeOperation) {
      await session.activeOperation.started.promise;
      const steered = await managedClient.steerThread(session.threadId, command.text);
      session.lastActivityAtMs = now();
      session.lastError = null;
      publish();
      return {
        ...command,
        ownership: 'managed',
        delivery: 'steered',
        turnId: steered.turnId,
        status: 'active',
      };
    }

    const controller = new AbortController();
    const started = Promise.withResolvers();
    void started.promise.catch(() => {});
    const operation = {
      controller,
      started,
      completion: null,
    };
    session.activeOperation = operation;
    session.status = 'active';
    session.lastActivityAtMs = now();
    session.lastError = null;
    publish();
    operation.completion = managedClient.executeThread(
      session.threadId,
      { prompt: command.text },
      controller.signal,
      { onTurnStarted: turnId => started.resolve(turnId) },
    );
    void operation.completion.then(
      text => finishManagedOperation(session, operation, text),
      error => {
        started.reject(error);
        failManagedOperation(session, operation, error);
      },
    );
    const turnId = await started.promise;
    return {
      ...command,
      ownership: 'managed',
      delivery: 'turn-started',
      turnId,
      status: 'observing',
    };
  }

  function finishManagedOperation(session, operation, text) {
    if (session.activeOperation !== operation || !sessions.has(session.sessionId)) return;
    const timestamp = now();
    session.activeOperation = null;
    session.status = 'waiting-input';
    session.lastActivityAtMs = timestamp;
    session.lastResponse = boundedTail(typeof text === 'string' ? text.trim() : '', 4_000) || null;
    session.lastError = null;
    publish();
    onManagedEvent({
      eventId: `managed-event-${++managedEventSequence}`,
      sessionId: session.sessionId,
      type: 'task-completed',
      observedAtMs: timestamp,
      status: 'completed',
      title: session.title,
      ...(session.lastResponse
        ? {
            lastVisibleLine: boundedTail(session.lastResponse, 500),
            visibleTextTail: session.lastResponse,
          }
        : {}),
    });
  }

  function failManagedOperation(session, operation, error) {
    if (session.activeOperation !== operation || !sessions.has(session.sessionId)) return;
    const timestamp = now();
    session.activeOperation = null;
    session.status = 'waiting-input';
    session.lastActivityAtMs = timestamp;
    session.lastError = errorMessage(error);
    publish();
    onManagedEvent({
      eventId: `managed-event-${++managedEventSequence}`,
      sessionId: session.sessionId,
      type: 'task-failed',
      observedAtMs: timestamp,
      status: 'failed',
      title: session.title,
      error: session.lastError,
    });
  }

  function snapshot() {
    const boundExternalIds = new Set(
      [...sessions.values()]
        .filter(session => session.ownership === 'external')
        .map(session => session.sourceSessionId),
    );
    return {
      phase,
      revision,
      persistence: 'memory-only',
      sessions: [...sessions.values()].map(publicSession),
      availableExternalSessions: [...externalCandidates.values()]
        .filter(candidate => !boundExternalIds.has(candidate.sourceSessionId))
        .map(candidate => ({ ...candidate })),
    };
  }

  async function close() {
    if (phase === 'closed') return;
    phase = 'closing';
    publish();
    const managed = [...sessions.values()].filter(session => session.ownership === 'managed');
    const external = [...sessions.values()].filter(session => session.ownership === 'external');
    await Promise.allSettled([
      ...managed.map(session => managedClient.archiveThread(session.threadId)),
      ...external.map(session => externalController.unwatchSession?.(session.sourceSessionId)),
    ]);
    sessions.clear();
    externalCandidates.clear();
    phase = 'closed';
    publish();
  }

  function requireOpen() {
    if (phase !== 'ready') throw new Error(`Conversation session registry is ${phase}`);
  }

  function publish() {
    revision++;
    onStateChanged(snapshot());
  }

  function externalSyncSignature() {
    return JSON.stringify({
      candidates: [...externalCandidates.values()]
        .sort((left, right) => left.sourceSessionId.localeCompare(right.sourceSessionId)),
      sessions: [...sessions.values()]
        .filter(session => session.ownership === 'external')
        .map(publicSession)
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
    });
  }
}

function normalizeExternalCandidate(value) {
  if (!record(value)) throw new TypeError('External conversation candidate must be an object');
  const sourceSessionId = nonEmptyText(value.sessionId, 'External conversation sessionId');
  return {
    sourceSessionId,
    title: optionalBoundedText(value.title, 300, 'External conversation title') ?? sourceSessionId,
    workDir: optionalBoundedText(value.workDir, 1_000, 'External conversation workDir') ?? null,
    status: externalRouteStatus(value),
  };
}

function normalizeExternalSyncOptions(value) {
  if (!record(value)) throw new TypeError('External conversation sync options must be an object');
  exactKeys(value, ['unavailableReason'], 'External conversation sync options');
  return {
    unavailableReason: optionalBoundedText(
      value.unavailableReason,
      1_000,
      'External conversation unavailable reason',
    ) ?? 'External conversation is no longer discoverable',
  };
}

function externalRouteStatus(value) {
  if (
    value.state !== 'running'
    || value.monitorState === 'closed'
    || value.agentState === 'closed'
  ) {
    return 'unavailable';
  }
  if (value.agentState === 'waiting_input') return 'waiting-input';
  if (value.agentState === 'active') return 'active';
  return 'idle-unknown';
}

function publicSession(session) {
  return {
    sessionId: session.sessionId,
    ownership: session.ownership,
    title: session.title,
    status: session.status,
    workDir: session.workDir,
    createdAtMs: session.createdAtMs,
    lastActivityAtMs: session.lastActivityAtMs,
    lastResponse: session.lastResponse,
    lastError: session.lastError,
    ...(session.ownership === 'managed'
      ? { threadId: session.threadId }
      : { sourceSessionId: session.sourceSessionId }),
  };
}

function normalizeCommand(value) {
  if (!record(value)) throw new TypeError('Conversation session command must be an object');
  exactKeys(
    value,
    ['commandId', 'sessionId', 'text', 'mode', 'contextRevision', 'resultArtifact'],
    'Conversation session command',
  );
  if (value.mode !== 'submit') throw new TypeError('Conversation session command mode must be submit');
  const result = {
    commandId: nonEmptyText(value.commandId, 'Conversation session commandId'),
    sessionId: nonEmptyText(value.sessionId, 'Conversation session command sessionId'),
    text: boundedText(value.text, 12_000, 'Conversation session command text'),
    mode: 'submit',
    contextRevision: nonNegativeInteger(
      value.contextRevision,
      'Conversation session command contextRevision',
    ),
  };
  if (value.resultArtifact !== undefined) {
    if (!record(value.resultArtifact)) {
      throw new TypeError('Conversation session resultArtifact must be an object');
    }
    exactKeys(
      value.resultArtifact,
      ['path', 'openOnCompletion'],
      'Conversation session resultArtifact',
    );
    if (typeof value.resultArtifact.openOnCompletion !== 'boolean') {
      throw new TypeError('Conversation session resultArtifact.openOnCompletion must be boolean');
    }
    result.resultArtifact = {
      path: nonEmptyText(
        value.resultArtifact.path,
        'Conversation session resultArtifact.path',
      ),
      openOnCompletion: value.resultArtifact.openOnCompletion,
    };
  }
  return result;
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalBoundedText(value, maximum, label) {
  if (value === undefined || value === null || value === '') return undefined;
  return boundedText(value, maximum, label);
}

function boundedText(value, maximum, label) {
  const normalized = nonEmptyText(value, label);
  if (normalized.length > maximum) {
    throw new RangeError(`${label} must not exceed ${maximum} characters`);
  }
  return normalized;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter(key => !allowedKeys.has(key));
  if (unknown.length > 0) throw new TypeError(`${label} contains unknown fields: ${unknown.join(', ')}`);
}

function boundedTail(value, maximum) {
  return value.length <= maximum ? value : value.slice(value.length - maximum);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
