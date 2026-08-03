export function createConversationSessionRegistry(options = {}) {
  const managedClient = options.managedClient;
  const externalController = options.externalController;
  const onStateChanged = options.onStateChanged ?? (() => {});
  const onManagedEvent = options.onManagedEvent ?? (() => {});
  const now = options.now ?? Date.now;
  const maxSessionRecords = boundedInteger(
    options.maxSessionRecords,
    24,
    4,
    100,
    'Conversation session maxSessionRecords',
  );
  if (!managedClient) throw new TypeError('Conversation session registry requires managedClient');
  if (!externalController) {
    throw new TypeError('Conversation session registry requires externalController');
  }
  const sessions = new Map();
  const externalCandidates = new Map();
  const seenExternalEventIds = new Set();
  const seenExternalEventOrder = [];
  let managedSequence = 0;
  let managedEventSequence = 0;
  let reviewSequence = 0;
  let recordSequence = 0;
  let revision = 0;
  let phase = 'ready';

  return {
    syncExternalSessions,
    observeExternalEvents,
    createManagedSession,
    bindExternalSession,
    reviewSession,
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
      lastReview: null,
      records: [],
      droppedRecordCount: 0,
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
    const watch = await externalController.watchSession(sourceSessionId);
    if (existing) {
      if (watch.review) {
        existing.lastReview = buildExternalReview(existing, watch.review, false);
        existing.lastResponse = watch.review.content.latestReply ?? existing.lastResponse;
        publish();
      }
      return publicSession(existing);
    }
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
      lastResponse: watch.review?.content.latestReply ?? null,
      lastError: candidate.status === 'unavailable'
        ? 'External conversation is unavailable'
        : null,
      lastReview: null,
      records: [],
      droppedRecordCount: 0,
      activeOperation: null,
    };
    if (watch.review) session.lastReview = buildExternalReview(session, watch.review, false);
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

  async function reviewSession(sessionId) {
    requireOpen();
    const normalizedSessionId = nonEmptyText(sessionId, 'Conversation sessionId');
    const session = sessions.get(normalizedSessionId);
    if (!session) throw new Error(`Conversation session is not registered: ${normalizedSessionId}`);
    let review;
    if (session.ownership === 'managed') {
      review = buildManagedReview(session);
    }
    else {
      try {
        if (typeof externalController.reviewSession !== 'function') {
          throw new Error('External conversation controller does not support read-only review');
        }
        review = buildExternalReview(
          session,
          await externalController.reviewSession(session.sourceSessionId),
          false,
        );
      }
      catch (error) {
        if (!session.lastReview) throw error;
        review = buildCachedReview(session, session.lastReview, errorMessage(error));
      }
    }
    session.lastReview = review;
    if (review.current.latestReply) session.lastResponse = review.current.latestReply;
    publish();
    return publicReview(review);
  }

  function observeExternalEvents(values = []) {
    if (phase === 'closed') return snapshot();
    let changed = false;
    for (const value of values) {
      if (!record(value)) continue;
      const identity = `${value.sourceInstanceId ?? 'unknown'}:${value.eventId ?? ''}`;
      if (!value.eventId || seenExternalEventIds.has(identity)) continue;
      rememberExternalEvent(identity);
      const session = [...sessions.values()].find(candidate =>
        candidate.ownership === 'external' && candidate.sourceSessionId === value.sessionId);
      if (!session || !Number.isInteger(value.observedAtMs) || value.observedAtMs < session.createdAtMs) {
        continue;
      }
      if (value.type === 'external-turn-completed' || value.type === 'task-completed') {
        const response = optionalBoundedText(value.latestReply, 4_000, 'External latest reply')
          ?? optionalBoundedText(value.visibleTextTail, 4_000, 'External visible text tail');
        if (response) {
          session.lastResponse = response;
          appendRecord(session, {
            direction: 'inbound',
            source: 'task-manager',
            atMs: value.observedAtMs,
            text: response,
          });
        }
        session.lastReview = buildReview(session, {
          source: 'session-monitor',
          stale: false,
          completion: 'complete',
          ...(optionalBoundedText(value.sourceRevision, 200, 'External source revision')
            ? { revision: value.sourceRevision }
            : {}),
          current: {
            ...(optionalBoundedText(value.lastVisibleLine, 500, 'External last visible line')
              ? { lastVisibleLine: value.lastVisibleLine }
              : {}),
            ...(optionalBoundedText(value.visibleTextTail, 4_000, 'External visible text tail')
              ? { visibleTextTail: value.visibleTextTail }
              : {}),
            ...(optionalBoundedText(value.latestReply, 4_000, 'External latest reply')
              ? { latestReply: value.latestReply }
              : {}),
          },
        });
        session.lastActivityAtMs = Math.max(session.lastActivityAtMs, value.observedAtMs);
        session.lastError = null;
        changed = true;
      }
      else if (value.type === 'task-failed' || value.type === 'task-unavailable') {
        const error = optionalBoundedText(value.error, 500, 'External task error')
          ?? `External task became ${value.status ?? 'unavailable'}`;
        appendRecord(session, {
          direction: 'status',
          source: 'task-manager',
          atMs: value.observedAtMs,
          text: error,
        });
        session.lastActivityAtMs = Math.max(session.lastActivityAtMs, value.observedAtMs);
        session.lastError = error;
        changed = true;
      }
    }
    if (changed) publish();
    return snapshot();
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
      if (result.status !== 'failed' && result.status !== 'unavailable') {
        appendRecord(session, {
          direction: 'outbound',
          source: 'desktop-char',
          atMs: session.lastActivityAtMs,
          text: command.text,
        });
      }
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
      appendRecord(session, {
        direction: 'outbound',
        source: 'desktop-char',
        atMs: session.lastActivityAtMs,
        text: command.text,
      });
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
    appendRecord(session, {
      direction: 'outbound',
      source: 'desktop-char',
      atMs: session.lastActivityAtMs,
      text: command.text,
    });
    publish();
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
    if (session.lastResponse) {
      appendRecord(session, {
        direction: 'inbound',
        source: 'managed',
        atMs: timestamp,
        text: session.lastResponse,
      });
    }
    session.lastReview = buildManagedReview(session);
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
    appendRecord(session, {
      direction: 'status',
      source: 'managed',
      atMs: timestamp,
      text: session.lastError,
    });
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

  function appendRecord(session, value) {
    session.records.push({
      recordId: `session-record-${++recordSequence}`,
      direction: value.direction,
      source: value.source,
      atMs: value.atMs,
      text: boundedTail(value.text, 2_000),
    });
    if (session.records.length > maxSessionRecords) {
      const removed = session.records.splice(0, session.records.length - maxSessionRecords);
      session.droppedRecordCount += removed.length;
    }
  }

  function rememberExternalEvent(identity) {
    seenExternalEventIds.add(identity);
    seenExternalEventOrder.push(identity);
    if (seenExternalEventOrder.length <= 1_000) return;
    const removed = seenExternalEventOrder.splice(0, seenExternalEventOrder.length - 1_000);
    for (const item of removed) seenExternalEventIds.delete(item);
  }

  function buildExternalReview(session, sourceReview, stale) {
    return buildReview(session, {
      source: stale ? 'cached' : 'session-monitor',
      stale,
      completion: sourceReview.state.completion,
      ...(sourceReview.source.screenChangedAtUtc
        ? { revision: sourceReview.source.screenChangedAtUtc }
        : {}),
      ...(sourceReview.source.observedAtUtc
        ? { observedAtUtc: sourceReview.source.observedAtUtc }
        : {}),
      current: {
        ...(sourceReview.content.lastVisibleLine
          ? { lastVisibleLine: sourceReview.content.lastVisibleLine }
          : {}),
        ...(sourceReview.content.visibleTextTail
          ? { visibleTextTail: sourceReview.content.visibleTextTail }
          : {}),
        ...(sourceReview.content.latestReply
          ? { latestReply: sourceReview.content.latestReply }
          : {}),
      },
    });
  }

  function buildManagedReview(session) {
    return buildReview(session, {
      source: 'managed-registry',
      stale: false,
      completion: session.status === 'waiting-input'
        ? 'complete'
        : session.status === 'active'
          ? 'in-progress'
          : session.status === 'unavailable'
            ? 'unavailable'
            : 'unknown',
      current: session.lastResponse ? { latestReply: session.lastResponse } : {},
    });
  }

  function buildCachedReview(session, previous, reason) {
    return buildReview(session, {
      source: 'cached',
      stale: true,
      completion: session.status === 'unavailable' ? 'unavailable' : previous.source.completion,
      ...(previous.source.revision ? { revision: previous.source.revision } : {}),
      ...(previous.source.observedAtUtc ? { observedAtUtc: previous.source.observedAtUtc } : {}),
      current: previous.current,
      error: boundedTail(reason, 500),
    });
  }

  function buildReview(session, source) {
    const capturedAtMs = now();
    return {
      schemaVersion: 'desktop-char.conversation-session-review.v1',
      reviewId: `session-review-${++reviewSequence}`,
      capturedAtMs,
      session: {
        sessionId: session.sessionId,
        ownership: session.ownership,
        title: session.title,
        status: session.status,
        registeredAtMs: session.createdAtMs,
        lastActivityAtMs: session.lastActivityAtMs,
        ...(session.workDir ? { workDir: session.workDir } : {}),
      },
      source: {
        kind: source.source,
        stale: source.stale,
        completion: source.completion,
        ...(source.revision ? { revision: source.revision } : {}),
        ...(source.observedAtUtc ? { observedAtUtc: source.observedAtUtc } : {}),
        ...(source.error ? { error: source.error } : {}),
      },
      current: { ...source.current },
      records: session.records.map(item => ({ ...item })),
      droppedRecordCount: session.droppedRecordCount,
    };
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
    lastReview: session.lastReview ? publicReview(session.lastReview) : null,
    recordCount: session.records.length,
    droppedRecordCount: session.droppedRecordCount,
    ...(session.ownership === 'managed'
      ? { threadId: session.threadId }
      : { sourceSessionId: session.sourceSessionId }),
  };
}

function publicReview(review) {
  return {
    ...review,
    session: { ...review.session },
    source: { ...review.source },
    current: { ...review.current },
    records: review.records.map(item => ({ ...item })),
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

function boundedInteger(value, fallback, minimum, maximum, label) {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return candidate;
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
