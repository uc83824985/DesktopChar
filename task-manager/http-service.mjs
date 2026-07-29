import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { TaskManagerError } from './task-manager-runtime.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function createTaskManagerHttpService(options) {
  if (!options?.runtime) throw new TypeError('Task Manager HTTP service requires a runtime');
  const runtime = options.runtime;
  const host = options.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new TypeError('Task Manager HTTP service must bind to a loopback host');
  }
  const port = integer(options.port ?? 0, 0, 65_535, 'Task Manager port');
  const token = nonEmptyText(options.token, 'Task Manager API token');
  const maxBodyBytes = integer(options.maxBodyBytes ?? 131_072, 1_024, 1_048_576, 'maxBodyBytes');
  let server;

  return {
    async listen() {
      if (server) return address();
      server = createServer((request, response) => {
        void handle(request, response).catch(error => {
          sendError(response, error);
        });
      });
      await new Promise((resolve, reject) => {
        const onError = error => {
          server?.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server?.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host, port });
      });
      return address();
    },
    async close() {
      const current = server;
      server = undefined;
      if (!current) return;
      await new Promise((resolve, reject) => {
        current.close(error => error ? reject(error) : resolve());
      });
    },
    address,
  };

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', `http://${host}`);
    if (request.method === 'GET' && url.pathname === '/health') {
      const snapshot = runtime.getSnapshot();
      return sendJson(response, 200, {
        ok: true,
        role: 'desktop_char_task_manager',
        phase: snapshot.phase,
        lastPollAtMs: snapshot.lastPollAtMs ?? null,
        lastError: snapshot.lastError ?? null,
      });
    }
    authorize(request, token);
    if (request.method === 'GET' && url.pathname === '/sessions') {
      return sendJson(response, 200, { ok: true, sessions: runtime.listSessions() });
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      const after = queryInteger(url.searchParams.get('after'), 0, 0, Number.MAX_SAFE_INTEGER, 'after');
      const limit = queryInteger(url.searchParams.get('limit'), 100, 1, 1_000, 'limit');
      return sendJson(response, 200, { ok: true, ...runtime.eventsAfter(after, limit) });
    }
    if (request.method === 'POST' && url.pathname === '/commands') {
      const command = await readJsonBody(request, maxBodyBytes);
      return sendJson(response, 202, { ok: true, command: await runtime.submitCommand(command) });
    }
    const ackMatch = /^\/events\/([^/]+)\/ack$/.exec(url.pathname);
    if (request.method === 'POST' && ackMatch) {
      await readJsonBody(request, maxBodyBytes, true);
      const event = runtime.ackEvent(decodeURIComponent(ackMatch[1]));
      return sendJson(response, 200, { ok: true, event });
    }
    sendJson(response, 404, { ok: false, error: 'not_found' });
  }

  function address() {
    const current = server?.address();
    if (!current || typeof current === 'string') return undefined;
    const hostname = current.family === 'IPv6' ? `[${current.address}]` : current.address;
    return {
      host: current.address,
      port: current.port,
      baseUrl: `http://${hostname}:${current.port}`,
    };
  }
}

function authorize(request, expectedToken) {
  const authorization = request.headers.authorization;
  const supplied = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expectedToken);
  if (
    suppliedBuffer.length !== expectedBuffer.length
    || !timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    throw new HttpServiceError(401, 'unauthorized');
  }
}

async function readJsonBody(request, maximum, emptyAllowed = false) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximum) throw new HttpServiceError(413, 'body_too_large');
    chunks.push(chunk);
  }
  if (chunks.length === 0 && emptyAllowed) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('JSON body must be an object');
    }
    return value;
  }
  catch (error) {
    throw new HttpServiceError(400, 'invalid_json', { cause: error });
  }
}

function sendError(response, error) {
  if (response.headersSent) return response.destroy();
  if (error instanceof HttpServiceError) {
    return sendJson(response, error.status, { ok: false, error: error.code });
  }
  if (error instanceof TaskManagerError) {
    const status = error.code === 'event-not-found'
      ? 404
      : error.code === 'idempotency-conflict'
        ? 409
        : error.code === 'closed'
          ? 503
          : 400;
    return sendJson(response, status, { ok: false, error: error.code, message: error.message });
  }
  sendJson(response, 500, { ok: false, error: 'internal_error' });
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

class HttpServiceError extends Error {
  constructor(status, code, options) {
    super(code, options);
    this.status = status;
    this.code = code;
  }
}

function queryInteger(value, fallback, minimum, maximum, label) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new HttpServiceError(400, `invalid_${label}`);
  return integer(Number(value), minimum, maximum, label);
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function nonEmptyText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}
