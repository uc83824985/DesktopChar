import { readFile } from 'node:fs/promises';
import path from 'node:path';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function createTaskManagerClient(options) {
  const markerPath = path.resolve(nonEmptyText(options?.markerPath, 'Task Manager marker path'));
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = boundedInteger(
    options.requestTimeoutMs,
    5_000,
    100,
    60_000,
    'Task Manager request timeout',
  );
  const readText = options.readText ?? (filePath => readFile(filePath, 'utf8'));
  let discovery;

  return {
    discover: loadDiscovery,
    async listSessions(signal) {
      const payload = await request('/sessions', {}, signal);
      if (!record(payload) || payload.ok !== true || !Array.isArray(payload.sessions)) {
        throw new TaskManagerClientError('invalid-response', 'Task Manager sessions response is invalid');
      }
      return structuredClone(payload.sessions);
    },
    async reviewSession(sessionId, signal) {
      const normalizedSessionId = nonEmptyText(sessionId, 'Task Manager reviewed sessionId');
      const payload = await request(
        `/sessions/${encodeURIComponent(normalizedSessionId)}/review`,
        {},
        signal,
      );
      if (!record(payload) || payload.ok !== true || !record(payload.review)) {
        throw new TaskManagerClientError('invalid-response', 'Task Manager review response is invalid');
      }
      return structuredClone(payload.review);
    },
    async eventsAfter(after, limit, signal) {
      const cursor = nonNegativeInteger(after, 'Task Manager event cursor');
      const pageSize = boundedInteger(limit, 100, 1, 1_000, 'Task Manager event limit');
      const payload = await request(`/events?after=${cursor}&limit=${pageSize}`, {}, signal);
      if (
        !record(payload)
        || payload.ok !== true
        || !Array.isArray(payload.events)
        || !Number.isInteger(payload.earliestCursor)
        || !Number.isInteger(payload.latestCursor)
        || typeof payload.gap !== 'boolean'
      ) {
        throw new TaskManagerClientError('invalid-response', 'Task Manager events response is invalid');
      }
      return {
        earliestCursor: payload.earliestCursor,
        latestCursor: payload.latestCursor,
        gap: payload.gap,
        events: structuredClone(payload.events),
      };
    },
    async ackEvent(eventId, signal) {
      const normalizedEventId = nonEmptyText(eventId, 'Task Manager eventId');
      const payload = await request(
        `/events/${encodeURIComponent(normalizedEventId)}/ack`,
        { method: 'POST' },
        signal,
      );
      if (!record(payload) || payload.ok !== true || !record(payload.event)) {
        throw new TaskManagerClientError('invalid-response', 'Task Manager ack response is invalid');
      }
      return structuredClone(payload.event);
    },
    async submitCommand(command, signal) {
      if (!record(command)) {
        throw new TypeError('Task Manager command must be an object');
      }
      const payload = await request(
        '/commands',
        {
          method: 'POST',
          body: JSON.stringify(command),
        },
        signal,
      );
      if (!record(payload) || payload.ok !== true || !record(payload.command)) {
        throw new TaskManagerClientError('invalid-response', 'Task Manager command response is invalid');
      }
      return structuredClone(payload.command);
    },
    async watchSession(sessionId, signal) {
      const normalizedSessionId = nonEmptyText(sessionId, 'Task Manager watched sessionId');
      const payload = await request(
        `/watches/${encodeURIComponent(normalizedSessionId)}`,
        { method: 'PUT' },
        signal,
      );
      if (!record(payload) || payload.ok !== true || !record(payload.watch)) {
        throw new TaskManagerClientError('invalid-response', 'Task Manager watch response is invalid');
      }
      return structuredClone(payload.watch);
    },
    async unwatchSession(sessionId, signal) {
      const normalizedSessionId = nonEmptyText(sessionId, 'Task Manager watched sessionId');
      const payload = await request(
        `/watches/${encodeURIComponent(normalizedSessionId)}`,
        { method: 'DELETE' },
        signal,
      );
      if (!record(payload) || payload.ok !== true || !record(payload.watch)) {
        throw new TaskManagerClientError('invalid-response', 'Task Manager unwatch response is invalid');
      }
      return structuredClone(payload.watch);
    },
    getDiscovery() {
      return discovery ? publicDiscovery(discovery) : undefined;
    },
  };

  async function loadDiscovery() {
    let marker;
    try {
      marker = JSON.parse(await readText(markerPath));
    }
    catch (error) {
      throw new TaskManagerClientError(
        'discovery-failed',
        `Could not read Task Manager marker ${markerPath}`,
        { cause: error },
      );
    }
    if (
      !record(marker)
      || marker.version !== 1
      || marker.role !== 'desktop_char_task_manager'
      || marker.persistence !== 'memory-only'
    ) {
      throw new TaskManagerClientError('invalid-marker', 'Task Manager marker is invalid');
    }
    const baseUrl = loopbackBaseUrl(marker.httpBaseUrl);
    const tokenFile = path.resolve(nonEmptyText(marker.httpTokenFile, 'Task Manager token file'));
    let token;
    try {
      token = (await readText(tokenFile)).trim();
    }
    catch (error) {
      throw new TaskManagerClientError(
        'discovery-failed',
        'Could not read Task Manager token file',
        { cause: error },
      );
    }
    if (!token || token.length > 4096) {
      throw new TaskManagerClientError('invalid-marker', 'Task Manager token is invalid');
    }
    discovery = {
      markerPath,
      instanceId: nonEmptyText(marker.instanceId, 'Task Manager instanceId'),
      baseUrl,
      token,
    };
    return publicDiscovery(discovery);
  }

  async function request(relativePath, init, signal) {
    const current = discovery ?? await discoverForRequest();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`Task Manager request timed out after ${requestTimeoutMs}ms`)),
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
      const text = await response.text();
      if (text.length > 2_000_000) {
        throw new TaskManagerClientError('invalid-response', 'Task Manager response is too large');
      }
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      }
      catch (error) {
        throw new TaskManagerClientError(
          'invalid-response',
          'Task Manager returned invalid JSON',
          { cause: error },
        );
      }
      if (!response.ok) {
        throw new TaskManagerClientError(
          response.status === 401 || response.status === 403 ? 'unauthorized' : 'request-failed',
          `Task Manager request failed (${response.status})`,
        );
      }
      return payload;
    }
    catch (error) {
      if (error instanceof TaskManagerClientError) throw error;
      throw new TaskManagerClientError(
        'unavailable',
        'Task Manager request failed',
        { cause: error },
      );
    }
    finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function discoverForRequest() {
    await loadDiscovery();
    return discovery;
  }
}

export class TaskManagerClientError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'TaskManagerClientError';
    this.code = code;
  }
}

function publicDiscovery(value) {
  return {
    markerPath: value.markerPath,
    instanceId: value.instanceId,
    baseUrl: value.baseUrl,
  };
}

function loopbackBaseUrl(value) {
  let url;
  try {
    url = new URL(nonEmptyText(value, 'Task Manager httpBaseUrl'));
  }
  catch (error) {
    throw new TaskManagerClientError('invalid-marker', 'Task Manager httpBaseUrl is invalid', {
      cause: error,
    });
  }
  if (
    url.protocol !== 'http:'
    || !LOOPBACK_HOSTS.has(url.hostname)
    || url.username
    || url.password
    || (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new TaskManagerClientError(
      'invalid-marker',
      'Task Manager httpBaseUrl must be an HTTP loopback origin',
    );
  }
  return `${url.origin}/`;
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

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
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
