import http from 'node:http';

const JSON_LIMIT_BYTES = 256 * 1024;

export function createAgentHttpServer(options) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 17373;
  let currentState = options.initialState ?? { ready: false, snapshot: null };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        return json(response, 200, { status: currentState.ready ? 'ready' : 'starting', service: 'desktop-char-agent' });
      }
      if (request.method === 'GET' && url.pathname === '/v1/capabilities') {
        return json(response, 200, {
          protocolVersion: 1,
          input: ['performance-plan', 'interrupt'],
          feedback: ['runtime-snapshot'],
          presentation: {
            speechBubbleModes: ['complete', 'stream', 'karaoke'],
            supportsAuthoredCues: true,
            textInput: 'complete-plan',
          },
          avatar: currentState.snapshot?.capabilities ?? null,
          tts: options.ttsContext ?? { mode: 'mock' },
        });
      }
      if (request.method === 'GET' && url.pathname === '/v1/state') return json(response, 200, currentState);
      if (request.method === 'POST' && url.pathname === '/v1/performances') {
        if (!currentState.ready) return json(response, 503, { error: 'avatar-not-ready' });
        if (currentState.snapshot?.state !== 'idle') return json(response, 409, { error: 'avatar-busy', snapshot: currentState.snapshot });
        const plan = validatePerformancePlan(await readJson(request));
        options.onCommand({ type: 'performance.submit', plan });
        return json(response, 202, { accepted: true, planId: plan.id });
      }
      if (request.method === 'POST' && url.pathname === '/v1/interrupt') {
        if (!currentState.ready) return json(response, 503, { error: 'avatar-not-ready' });
        options.onCommand({ type: 'performance.interrupt' });
        return json(response, 202, { accepted: true });
      }
      json(response, 404, { error: 'not-found' });
    }
    catch (error) {
      json(response, error instanceof AgentRequestError ? error.status : 500, {
        error: error instanceof AgentRequestError ? error.code : 'internal-error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return {
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve(server.address());
      });
    }),
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    updateState(state) { currentState = structuredClone(state); },
  };
}

export function parseAgentPort(value) {
  if (value === undefined || value === '') return 17373;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('DESKTOP_CHAR_AGENT_PORT must be an integer from 0 to 65535');
  return port;
}

function validatePerformancePlan(value) {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) throw bad('invalid-plan', 'plan.id must be a non-empty string');
  if (!Array.isArray(value.segments) || value.segments.length === 0) throw bad('invalid-plan', 'plan.segments must be a non-empty array');
  const ids = new Set();
  const sequences = new Set();
  const segments = value.segments.map((segment, index) => {
    if (!isRecord(segment)) throw bad('invalid-segment', `segments[${index}] must be an object`);
    if (typeof segment.id !== 'string' || !segment.id.trim() || ids.has(segment.id)) throw bad('invalid-segment', `segments[${index}].id must be non-empty and unique`);
    if (!Number.isInteger(segment.sequence) || segment.sequence < 0 || sequences.has(segment.sequence)) throw bad('invalid-segment', `segments[${index}].sequence must be a unique non-negative integer`);
    if (typeof segment.displayText !== 'string' || typeof segment.speechText !== 'string' || !segment.speechText.trim()) throw bad('invalid-segment', `segments[${index}] requires displayText and non-empty speechText`);
    if (segment.emotion !== undefined) validateEmotion(segment.emotion, index);
    if (segment.actions !== undefined) validateActions(segment.actions, index);
    if (segment.bubble !== undefined) validateBubble(segment.bubble, segment.displayText, index);
    ids.add(segment.id); sequences.add(segment.sequence);
    return structuredClone(segment);
  });
  return { id: value.id, segments };
}

function validateBubble(value, displayText, segmentIndex) {
  const modes = new Set(['stream', 'karaoke', 'complete']);
  if (!isRecord(value) || !modes.has(value.mode)) throw bad('invalid-segment', `segments[${segmentIndex}].bubble.mode is invalid`);
  if (value.charactersPerSecond !== undefined && (!Number.isFinite(value.charactersPerSecond) || value.charactersPerSecond <= 0)) {
    throw bad('invalid-segment', `segments[${segmentIndex}].bubble.charactersPerSecond must be positive`);
  }
  if (value.cues === undefined) return;
  if (!Array.isArray(value.cues)) throw bad('invalid-segment', `segments[${segmentIndex}].bubble.cues must be an array`);
  let previousAtMs = -1;
  let combined = '';
  value.cues.forEach((cue, cueIndex) => {
    if (!isRecord(cue) || typeof cue.text !== 'string' || !cue.text
      || !Number.isFinite(cue.atMs) || cue.atMs < 0 || cue.atMs < previousAtMs
      || (cue.durationMs !== undefined && (!Number.isFinite(cue.durationMs) || cue.durationMs <= 0))) {
      throw bad('invalid-segment', `segments[${segmentIndex}].bubble.cues[${cueIndex}] is invalid`);
    }
    previousAtMs = cue.atMs;
    combined += cue.text;
  });
  if (combined !== displayText) throw bad('invalid-segment', `segments[${segmentIndex}].bubble.cues must concatenate to displayText`);
}

function validateEmotion(value, segmentIndex) {
  const allowed = new Set(['neutral', 'happy', 'sad', 'angry', 'surprised', 'thinking']);
  if (!isRecord(value) || !allowed.has(value.emotion) || typeof value.intensity !== 'number' || !Number.isFinite(value.intensity)) {
    throw bad('invalid-segment', `segments[${segmentIndex}].emotion is invalid`);
  }
  if (value.atMs !== undefined && (!Number.isFinite(value.atMs) || value.atMs < 0)) throw bad('invalid-segment', `segments[${segmentIndex}].emotion.atMs must be non-negative`);
}

function validateActions(value, segmentIndex) {
  const allowed = new Set(['nod', 'shake', 'tap', 'greet']);
  if (!Array.isArray(value)) throw bad('invalid-segment', `segments[${segmentIndex}].actions must be an array`);
  value.forEach((action, actionIndex) => {
    if (!isRecord(action) || typeof action.id !== 'string' || !action.id.trim() || !allowed.has(action.action)) throw bad('invalid-segment', `segments[${segmentIndex}].actions[${actionIndex}] is invalid`);
    if (action.atMs !== undefined && (!Number.isFinite(action.atMs) || action.atMs < 0)) throw bad('invalid-segment', `segments[${segmentIndex}].actions[${actionIndex}].atMs must be non-negative`);
  });
}

async function readJson(request) {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) throw new AgentRequestError(415, 'unsupported-media-type', 'Content-Type must be application/json');
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > JSON_LIMIT_BYTES) throw new AgentRequestError(413, 'payload-too-large', `JSON body exceeds ${JSON_LIMIT_BYTES} bytes`);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw bad('invalid-json', 'Request body is not valid JSON'); }
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
}
function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function bad(code, message) { return new AgentRequestError(400, code, message); }
class AgentRequestError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
