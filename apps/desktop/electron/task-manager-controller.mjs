import { createTaskManagerClient } from './task-manager-client.mjs';

export function createTaskManagerController(initialConfig, options = {}) {
  const createClient = options.createClient ?? (config =>
    createTaskManagerClient({
      markerPath: config.markerPath,
      requestTimeoutMs: config.requestTimeoutMs,
    }));
  const launchManagedProcess = options.launchManagedProcess;
  const onStateChanged = options.onStateChanged ?? (() => {});
  const restartDelayMs = options.restartDelayMs ?? 1_000;
  let config = normalizeConfig(initialConfig);
  let enabledOverride;
  let client;
  let timer;
  let polling;
  let closed = false;
  let activeProcess;
  let processId = null;
  let operation = Promise.resolve();
  let restartTimer;
  let reconnectAttempt = 0;
  let activeSignature = '';
  let instanceId;
  let cursor = 0;
  let sessions = [];
  let events = [];
  let pendingAckIds = new Set();
  let endpointRevision = 0;
  let phase = config.enabled ? 'standby' : 'disabled';
  let lastError;
  let lastPollAtMs;

  return {
    start,
    close,
    configure,
    setEnabled,
    pollNow,
    submitCommand,
    snapshot,
  };

  function desiredEnabled() {
    return enabledOverride ?? config.enabled;
  }

  function enqueue(task) {
    const next = operation.catch(() => {}).then(task);
    operation = next.catch(() => {});
    return next;
  }

  function start() {
    if (closed) throw new Error('Task Manager controller is closed');
    return enqueue(() => reconcile('startup'));
  }

  function close() {
    if (closed) return operation;
    closed = true;
    enabledOverride = false;
    clearSchedule();
    clearRestart();
    invalidateEndpoint();
    return enqueue(async () => {
      await stopManagedProcess();
      phase = 'closed';
      processId = null;
      publish();
      return snapshot();
    });
  }

  function configure(nextConfig) {
    const next = normalizeConfig(nextConfig);
    const endpointChanged = config.markerPath !== next.markerPath
      || config.requestTimeoutMs !== next.requestTimeoutMs
      || config.lifecycle !== next.lifecycle
      || config.sessionMonitorMarkerPath !== next.sessionMonitorMarkerPath
      || config.stateDirectory !== next.stateDirectory;
    const activePoll = polling;
    config = next;
    enabledOverride = undefined;
    clearSchedule();
    clearRestart();
    if (endpointChanged) {
      invalidateEndpoint();
    }
    publish();
    const proceed = activePoll ? activePoll.catch(() => {}) : Promise.resolve();
    return enqueue(async () => {
      await proceed;
      return reconcile('config-reload');
    });
  }

  function setEnabled(enabled) {
    if (typeof enabled !== 'boolean') {
      throw new TypeError('Task Manager enabled state must be boolean');
    }
    if (closed) throw new Error('Task Manager controller is closed');
    enabledOverride = enabled;
    clearRestart();
    publish();
    return enqueue(() => reconcile('runtime-toggle'));
  }

  async function pollNow() {
    if (
      closed
      || !desiredEnabled()
      || (config.lifecycle === 'managed' && !activeProcess)
    ) {
      return snapshot();
    }
    if (polling) return polling;
    polling = performPoll().finally(() => { polling = undefined; });
    return polling;
  }

  async function submitCommand(input) {
    if (closed) throw new Error('Task Manager controller is closed');
    if (!desiredEnabled()) throw new Error('Task Manager is disabled');
    if (config.lifecycle === 'managed' && !activeProcess) {
      throw new Error('Task Manager managed service is unavailable');
    }
    const command = normalizeCommand(input);
    client ??= createClient(config);
    await client.discover();
    const result = await client.submitCommand(command);
    void pollNow().catch(() => {});
    return result;
  }

  async function reconcile(reason) {
    if (closed) return snapshot();
    clearSchedule();
    clearRestart();
    if (!desiredEnabled()) {
      invalidateEndpoint();
      await stopManagedProcess();
      phase = 'disabled';
      lastError = undefined;
      reconnectAttempt = 0;
      publish();
      return snapshot();
    }
    if (config.lifecycle === 'external') {
      await stopManagedProcess();
      reconnectAttempt = 0;
      schedule();
      await pollNow().catch(() => {});
      return snapshot();
    }
    if (!config.sessionMonitorMarkerPath) {
      invalidateEndpoint();
      await stopManagedProcess();
      phase = 'reconnecting';
      lastError = 'Managed Task Manager requires a Session Monitor marker';
      publish();
      return snapshot();
    }
    const signature = managedSignature(config);
    if (activeProcess && activeSignature === signature) {
      schedule();
      await pollNow().catch(() => {});
      return snapshot();
    }
    await stopManagedProcess();
    if (typeof launchManagedProcess !== 'function') {
      phase = 'reconnecting';
      lastError = 'Managed Task Manager process launcher is unavailable';
      publish();
      return snapshot();
    }

    invalidateEndpoint();
    phase = reason === 'failure-restart' ? 'reconnecting' : 'connecting';
    lastError = undefined;
    publish();
    const targetConfig = config;
    let candidate;
    try {
      candidate = await launchManagedProcess(targetConfig);
      if (closed || !desiredEnabled() || config !== targetConfig) {
        await candidate.close(targetConfig.shutdownTimeoutMs);
        return snapshot();
      }
      activeProcess = candidate;
      activeSignature = signature;
      processId = candidate.pid ?? null;
      observeManagedExit(candidate);
      publish();
      await waitUntilManagedReady(candidate, targetConfig);
      if (
        closed
        || activeProcess !== candidate
        || !desiredEnabled()
        || config !== targetConfig
      ) {
        if (activeProcess === candidate) await stopManagedProcess();
        return snapshot();
      }
      reconnectAttempt = 0;
      schedule();
      return snapshot();
    }
    catch (error) {
      if (activeProcess === candidate) {
        activeProcess = undefined;
        activeSignature = '';
        processId = null;
      }
      await candidate?.close(targetConfig.shutdownTimeoutMs).catch(() => {});
      handleManagedFailure(error);
      return snapshot();
    }
  }

  async function waitUntilManagedReady(process, targetConfig) {
    const deadline = Date.now() + targetConfig.startupTimeoutMs;
    let latestError;
    while (Date.now() < deadline) {
      if (
        closed
        || activeProcess !== process
        || !desiredEnabled()
        || config !== targetConfig
      ) {
        throw new Error('Managed Task Manager startup was cancelled');
      }
      if (process.exitInfo) throw managedProcessExitError(process.exitInfo);
      try {
        await performPoll(true);
        return;
      }
      catch (error) {
        latestError = error;
        await delay(100);
      }
    }
    throw new Error(
      `Managed Task Manager did not become ready within ${targetConfig.startupTimeoutMs} ms: `
      + errorMessage(latestError),
    );
  }

  async function performPoll(starting = false) {
    const operationRevision = endpointRevision;
    const operationalPoll = !starting && (phase === 'ready' || phase === 'degraded');
    if (!operationalPoll) {
      phase = starting ? 'connecting' : instanceId ? 'reconnecting' : 'connecting';
      publish();
    }
    try {
      const operationClient = client ?? createClient(config);
      client = operationClient;
      const discovery = await operationClient.discover();
      if (!currentEndpointOperation(operationRevision, operationClient)) return snapshot();
      const sourceInstanceId = nonEmptyText(
        discovery.instanceId,
        'Task Manager discovery instanceId',
      );
      if (instanceId !== sourceInstanceId) {
        instanceId = sourceInstanceId;
        cursor = 0;
        pendingAckIds = new Set();
      }
      let degradedError;
      await retryAcks(operationClient);
      if (!currentEndpointOperation(operationRevision, operationClient)) return snapshot();
      const nextSessions = (await operationClient.listSessions()).map(normalizeSession);
      if (!currentEndpointOperation(operationRevision, operationClient)) return snapshot();
      const page = await operationClient.eventsAfter(cursor, config.eventPageSize);
      if (!currentEndpointOperation(operationRevision, operationClient)) return snapshot();
      sessions = nextSessions;
      if (page.gap) {
        degradedError = `Task Manager event cursor gap before ${page.earliestCursor}`;
      }
      for (const rawEvent of page.events) {
        const event = normalizeEvent(rawEvent, sourceInstanceId);
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
        await retryAcks(operationClient);
      }
      catch (error) {
        degradedError = errorMessage(error);
      }
      lastPollAtMs = Date.now();
      lastError = degradedError;
      reconnectAttempt = 0;
      phase = degradedError ? 'degraded' : 'ready';
      publish();
      return snapshot();
    }
    catch (error) {
      sessions = [];
      reconnectAttempt++;
      phase = starting ? 'connecting' : 'reconnecting';
      lastError = errorMessage(error);
      publish();
      throw error;
    }
  }

  async function retryAcks(targetClient = client) {
    for (const eventId of [...pendingAckIds]) {
      await targetClient.ackEvent(eventId);
      pendingAckIds.delete(eventId);
    }
  }

  function schedule() {
    clearSchedule();
    timer = setInterval(() => {
      void pollNow().catch(() => {});
    }, config.pollIntervalMs);
    timer.unref?.();
  }

  function clearSchedule() {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  function invalidateEndpoint() {
    endpointRevision++;
    client = undefined;
    instanceId = undefined;
    cursor = 0;
    pendingAckIds = new Set();
    sessions = [];
  }

  function currentEndpointOperation(revision, operationClient) {
    return revision === endpointRevision && operationClient === client;
  }

  function observeManagedExit(process) {
    void process.exited.then(info => {
      if (activeProcess !== process || closed) return;
      activeProcess = undefined;
      activeSignature = '';
      processId = null;
      clearSchedule();
      invalidateEndpoint();
      handleManagedFailure(managedProcessExitError(info));
    });
  }

  function handleManagedFailure(error) {
    lastError = errorMessage(error);
    reconnectAttempt++;
    if (
      !closed
      && desiredEnabled()
      && config.lifecycle === 'managed'
      && config.restartOnFailure
      && config.sessionMonitorMarkerPath
    ) {
      phase = 'reconnecting';
      scheduleRestart();
    }
    else {
      phase = desiredEnabled() ? 'reconnecting' : 'disabled';
    }
    publish();
  }

  function scheduleRestart() {
    clearRestart();
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      void enqueue(() => reconcile('failure-restart'));
    }, restartDelayMs);
    restartTimer.unref?.();
  }

  function clearRestart() {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = undefined;
  }

  async function stopManagedProcess() {
    const process = activeProcess;
    activeProcess = undefined;
    activeSignature = '';
    processId = null;
    if (!process) return;
    await process.close(config.shutdownTimeoutMs).catch(() => {});
  }

  function snapshot() {
    return {
      enabled: desiredEnabled(),
      lifecycle: config.lifecycle,
      phase,
      markerPath: config.markerPath,
      sessionMonitorMarkerPath: config.sessionMonitorMarkerPath || null,
      processId,
      reconnectAttempt,
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
  const lifecycle = value.lifecycle ?? 'external';
  if (lifecycle !== 'managed' && lifecycle !== 'external') {
    throw new TypeError('Task Manager lifecycle must be managed or external');
  }
  const markerPath = typeof value.markerPath === 'string' ? value.markerPath.trim() : '';
  if (enabled && !markerPath) throw new TypeError('Enabled Task Manager requires markerPath');
  return {
    enabled,
    lifecycle,
    markerPath,
    sessionMonitorMarkerPath: typeof value.sessionMonitorMarkerPath === 'string'
      ? value.sessionMonitorMarkerPath.trim()
      : '',
    stateDirectory: typeof value.stateDirectory === 'string' ? value.stateDirectory.trim() : '',
    startupTimeoutMs: boundedInteger(
      value.startupTimeoutMs,
      10_000,
      500,
      120_000,
      'startupTimeoutMs',
    ),
    shutdownTimeoutMs: boundedInteger(
      value.shutdownTimeoutMs,
      10_000,
      500,
      120_000,
      'shutdownTimeoutMs',
    ),
    restartOnFailure: value.restartOnFailure !== false,
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

function managedProcessExitError(info) {
  const detail = info?.stderrTail?.trim() || info?.stdoutTail?.trim();
  return new Error(
    `Managed Task Manager exited (code=${String(info?.code)}, `
    + `signal=${String(info?.signal)})${detail ? `: ${detail}` : ''}`,
  );
}

function managedSignature(config) {
  return JSON.stringify({
    markerPath: config.markerPath,
    sessionMonitorMarkerPath: config.sessionMonitorMarkerPath,
    stateDirectory: config.stateDirectory,
  });
}

function delay(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
