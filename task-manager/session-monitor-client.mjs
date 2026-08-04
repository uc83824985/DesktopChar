import { readFile } from 'node:fs/promises';
import path from 'node:path';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export async function discoverSessionMonitor(markerPath, options = {}) {
  const resolvedMarkerPath = path.resolve(nonEmptyText(markerPath, 'Session Monitor marker path'));
  const readText = options.readText ?? (filePath => readFile(filePath, 'utf8'));
  let marker;
  try {
    marker = JSON.parse(await readText(resolvedMarkerPath));
  }
  catch (error) {
    throw new SessionMonitorClientError(
      'discovery-failed',
      `Could not read Session Monitor marker ${resolvedMarkerPath}`,
      { cause: error },
    );
  }
  if (!record(marker) || marker.role !== 'session_monitor') {
    throw new SessionMonitorClientError(
      'invalid-marker',
      'Session Monitor marker has an invalid role',
    );
  }
  if (!Number.isInteger(marker.version) || marker.version < 3) {
    throw new SessionMonitorClientError(
      'invalid-marker',
      'Session Monitor marker version must support session input discovery',
    );
  }
  const baseUrl = loopbackBaseUrl(marker.httpBaseUrl);
  const capability = record(marker.capabilities) && record(marker.capabilities.sessionInput)
    ? marker.capabilities.sessionInput
    : undefined;
  if (
    !capability
    || capability.enabled !== true
    || !Array.isArray(capability.modes)
    || !capability.modes.includes('submit')
  ) {
    throw new SessionMonitorClientError(
      'input-unsupported',
      'Session Monitor does not advertise submit input capability',
    );
  }
  const tokenFile = path.resolve(nonEmptyText(marker.httpTokenFile, 'Session Monitor token file'));
  let token;
  try {
    token = (await readText(tokenFile)).trim();
  }
  catch (error) {
    throw new SessionMonitorClientError(
      'discovery-failed',
      'Could not read the Session Monitor token file',
      { cause: error },
    );
  }
  if (!token || token.length > 4096) {
    throw new SessionMonitorClientError('invalid-marker', 'Session Monitor token is invalid');
  }
  const intervalMs = boundedInteger(marker.intervalMs, 1_000, 100, 60_000, 'marker.intervalMs');
  const maxTextChars = boundedInteger(
    capability.maxTextChars,
    32_768,
    1,
    1_000_000,
    'capabilities.sessionInput.maxTextChars',
  );
  const observationCapability = record(marker.capabilities.sessionObservation)
    ? marker.capabilities.sessionObservation
    : undefined;
  const structuredObservation = structuredObservationCapability(observationCapability);
  return {
    markerPath: resolvedMarkerPath,
    markerVersion: marker.version,
    baseUrl,
    tokenFile,
    token,
    intervalMs,
    maxTextChars,
    structuredObservation,
  };
}

export function createSessionMonitorClient(options) {
  const markerPath = path.resolve(nonEmptyText(options?.markerPath, 'Session Monitor marker path'));
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = boundedInteger(
    options.requestTimeoutMs,
    5_000,
    100,
    60_000,
    'Session Monitor request timeout',
  );
  let discovery;

  return {
    async discover() {
      discovery = await discoverSessionMonitor(markerPath, options);
      return publicDiscovery(discovery);
    },
    async listSessions(listOptions = {}) {
      const response = await request(
        `/api/sessions${listOptions.full === false ? '' : '?full=true'}`,
        {},
        listOptions.signal,
      );
      if (!record(response) || response.ok !== true || !Array.isArray(response.sessions)) {
        throw new SessionMonitorClientError(
          'invalid-response',
          'Session Monitor sessions response is invalid',
        );
      }
      return response.sessions.map((session, index) => normalizeSession(session, `sessions[${index}]`));
    },
    async getSession(sessionId, requestOptions = {}) {
      const normalizedSessionId = nonEmptyText(sessionId, 'sessionId');
      const response = await request(
        `/api/sessions/${encodeURIComponent(normalizedSessionId)}`,
        {},
        requestOptions.signal,
      );
      if (!record(response) || response.ok !== true || !record(response.session)) {
        throw new SessionMonitorClientError(
          'invalid-response',
          `Session Monitor response for ${normalizedSessionId} is invalid`,
        );
      }
      return normalizeSession(response.session, 'session');
    },
    async submitInput(sessionId, text, requestOptions = {}) {
      const normalizedSessionId = nonEmptyText(sessionId, 'sessionId');
      const bodyText = nonEmptyText(text, 'Session input text', false);
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(bodyText)) {
        throw new SessionMonitorClientError(
          'invalid-request',
          'Session input contains an unsupported control character',
        );
      }
      const current = await ensureDiscovery();
      if (bodyText.length > current.maxTextChars) {
        throw new SessionMonitorClientError(
          'invalid-request',
          `Session input exceeds the advertised ${current.maxTextChars} character limit`,
        );
      }
      const response = await request(
        `/api/sessions/${encodeURIComponent(normalizedSessionId)}/input`,
        {
          method: 'POST',
          body: JSON.stringify({ text: bodyText, mode: 'submit' }),
        },
        requestOptions.signal,
      );
      if (
        !record(response)
        || response.ok !== true
        || response.sessionId !== normalizedSessionId
        || response.mode !== 'submit'
        || response.submitted !== true
      ) {
        throw new SessionMonitorClientError(
          'invalid-response',
          `Session Monitor did not confirm submission to ${normalizedSessionId}`,
        );
      }
      return {
        sessionId: normalizedSessionId,
        submitted: true,
        agentState: typeof response.agentState === 'string' ? response.agentState : 'unknown',
      };
    },
    getDiscovery() {
      return discovery ? publicDiscovery(discovery) : undefined;
    },
  };

  async function request(relativePath, init, signal) {
    let current = await ensureDiscovery();
    try {
      return await perform(current, relativePath, init, signal);
    }
    catch (error) {
      if (!(error instanceof SessionMonitorClientError)
        || !['unauthorized', 'unavailable'].includes(error.code)) {
        throw error;
      }
      current = await discoverSessionMonitor(markerPath, options);
      discovery = current;
      return perform(current, relativePath, init, signal);
    }
  }

  async function perform(current, relativePath, init, signal) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`Session Monitor request timed out after ${requestTimeoutMs}ms`)),
      requestTimeoutMs,
    );
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      const response = await fetchImpl(new URL(relativePath, current.baseUrl), {
        ...init,
        headers: {
          Authorization: `Bearer ${current.token}`,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
        },
        signal: controller.signal,
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403
          ? 'unauthorized'
          : response.status === 404
            ? 'session-unavailable'
            : 'request-failed';
        throw new SessionMonitorClientError(
          code,
          safeRemoteError(payload, response.status),
        );
      }
      return payload;
    }
    catch (error) {
      if (error instanceof SessionMonitorClientError) throw error;
      throw new SessionMonitorClientError(
        'unavailable',
        'Session Monitor request failed',
        { cause: error },
      );
    }
    finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function ensureDiscovery() {
    if (!discovery) discovery = await discoverSessionMonitor(markerPath, options);
    return discovery;
  }
}

export class SessionMonitorClientError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'SessionMonitorClientError';
    this.code = code;
  }
}

function normalizeSession(value, label) {
  if (!record(value)) {
    throw new SessionMonitorClientError('invalid-response', `${label} must be an object`);
  }
  const sessionId = nonEmptyText(value.sessionId, `${label}.sessionId`);
  const latestCompletedReply = value.latestCompletedReply === undefined
    || value.latestCompletedReply === null
    ? undefined
    : normalizeCompletedReply(value.latestCompletedReply, `${label}.latestCompletedReply`);
  return {
    sessionId,
    state: enumText(value.state, ['running', 'exited', 'closed', 'stale'], `${label}.state`),
    monitorState: enumText(
      value.monitorState,
      ['pending', 'observed', 'unreadable', 'closed'],
      `${label}.monitorState`,
    ),
    agentState: enumText(
      value.agentState,
      ['waiting_input', 'active', 'idle_unknown', 'unknown', 'closed'],
      `${label}.agentState`,
    ),
    ...(optionalEnumText(
      value.agentStateSource,
      ['codex_rollout', 'terminal'],
      `${label}.agentStateSource`,
    )
      ? { agentStateSource: value.agentStateSource }
      : {}),
    ...(optionalText(value.agentStateChangedAtUtc)
      ? { agentStateChangedAtUtc: optionalText(value.agentStateChangedAtUtc) }
      : {}),
    ...(optionalNonNegativeInteger(value.turnRevision, `${label}.turnRevision`) !== undefined
      ? { turnRevision: value.turnRevision }
      : {}),
    ...(optionalText(value.submissionId) ? { submissionId: optionalText(value.submissionId) } : {}),
    ...(optionalText(value.activeSubmissionId)
      ? { activeSubmissionId: optionalText(value.activeSubmissionId) }
      : {}),
    ...(optionalNonNegativeInteger(
      value.completionRevision,
      `${label}.completionRevision`,
    ) !== undefined
      ? { completionRevision: value.completionRevision }
      : {}),
    ...(latestCompletedReply ? { latestCompletedReply } : {}),
    agent: optionalText(value.agent),
    title: optionalText(value.desiredTitle ?? value.currentTitle ?? value.baseTitle),
    workDir: optionalText(value.workDir ?? value.root),
    lastVisibleText: optionalText(value.lastVisibleText, true),
    lastVisibleNonEmptyLine: optionalText(value.lastVisibleNonEmptyLine, true),
    lastVisibleTextHash: optionalText(value.lastVisibleTextHash),
    lastScreenChangedAtUtc: optionalText(value.lastScreenChangedAtUtc),
    lastObservedAtUtc: optionalText(value.lastObservedAtUtc),
  };
}

function normalizeCompletedReply(value, label) {
  if (!record(value)) {
    throw new SessionMonitorClientError('invalid-response', `${label} must be an object`);
  }
  const completionRevision = nonNegativeInteger(
    value.completionRevision,
    `${label}.completionRevision`,
  );
  const sourceText = nonEmptyText(value.text, `${label}.text`, false);
  const text = sourceText.length <= 12_000 ? sourceText : sourceText.slice(-12_000);
  const originalTextLength = optionalNonNegativeInteger(
    value.originalTextLength,
    `${label}.originalTextLength`,
  );
  const durationMs = optionalNonNegativeInteger(value.durationMs, `${label}.durationMs`);
  const timeToFirstTokenMs = optionalNonNegativeInteger(
    value.timeToFirstTokenMs,
    `${label}.timeToFirstTokenMs`,
  );
  if (value.textTruncated !== undefined && typeof value.textTruncated !== 'boolean') {
    throw new SessionMonitorClientError(
      'invalid-response',
      `${label}.textTruncated must be a boolean`,
    );
  }
  return {
    source: enumText(value.source, ['codex_rollout'], `${label}.source`),
    submissionId: nonEmptyText(value.submissionId, `${label}.submissionId`),
    completionRevision,
    ...(optionalText(value.startedAtUtc) ? { startedAtUtc: optionalText(value.startedAtUtc) } : {}),
    ...(optionalText(value.completedAtUtc) ? { completedAtUtc: optionalText(value.completedAtUtc) } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
    text,
    ...(optionalText(value.textHash) ? { textHash: optionalText(value.textHash) } : {}),
    ...(originalTextLength !== undefined ? { originalTextLength } : {}),
    ...(value.textTruncated !== undefined ? { textTruncated: value.textTruncated } : {}),
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (text.length > 16_000_000) {
    throw new SessionMonitorClientError('invalid-response', 'Session Monitor response is too large');
  }
  try {
    return text ? JSON.parse(text) : {};
  }
  catch (error) {
    throw new SessionMonitorClientError(
      'invalid-response',
      'Session Monitor returned invalid JSON',
      { cause: error },
    );
  }
}

function safeRemoteError(payload, status) {
  if (record(payload)) {
    const code = optionalText(payload.error ?? payload.code);
    if (code) return `Session Monitor request failed (${status}: ${code})`;
  }
  return `Session Monitor request failed (${status})`;
}

function publicDiscovery(value) {
  return {
    markerPath: value.markerPath,
    markerVersion: value.markerVersion,
    baseUrl: value.baseUrl,
    intervalMs: value.intervalMs,
    maxTextChars: value.maxTextChars,
    structuredObservation: value.structuredObservation,
  };
}

function loopbackBaseUrl(value) {
  let url;
  try {
    url = new URL(nonEmptyText(value, 'Session Monitor httpBaseUrl'));
  }
  catch (error) {
    throw new SessionMonitorClientError(
      'invalid-marker',
      'Session Monitor httpBaseUrl is invalid',
      { cause: error },
    );
  }
  if (
    url.protocol !== 'http:'
    || !LOOPBACK_HOSTS.has(url.hostname)
    || url.username
    || url.password
    || (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new SessionMonitorClientError(
      'invalid-marker',
      'Session Monitor httpBaseUrl must be an HTTP loopback origin',
    );
  }
  return `${url.origin}/`;
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function enumText(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new SessionMonitorClientError('invalid-response', `${label} is invalid`);
  }
  return value;
}

function optionalEnumText(value, allowed, label) {
  if (value === undefined || value === null || value === '') return undefined;
  return enumText(value, allowed, label);
}

function nonEmptyText(value, label, trim = true) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return trim ? value.trim() : value;
}

function optionalText(value, preserveWhitespace = false) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return preserveWhitespace ? value : value.trim();
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new SessionMonitorClientError('invalid-response', `${label} must be non-negative`);
  }
  return value;
}

function optionalNonNegativeInteger(value, label) {
  if (value === undefined || value === null) return undefined;
  return nonNegativeInteger(value, label);
}

function structuredObservationCapability(value) {
  if (!value || value.enabled !== true || value.structuredCodexRollout !== true) return false;
  if (!Array.isArray(value.fields)) return false;
  const fields = new Set(value.fields.filter(field => typeof field === 'string'));
  return [
    'agentStateSource',
    'turnRevision',
    'submissionId',
    'activeSubmissionId',
    'completionRevision',
    'latestCompletedReply',
  ].every(field => fields.has(field));
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new SessionMonitorClientError(
      'invalid-marker',
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return result;
}
