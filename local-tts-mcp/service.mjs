import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import {
  TTS_MCP_PROFILE,
  TTS_MCP_PROFILE_VERSION,
  TTS_MCP_TOOLS,
} from '../tts-mcp-profile/contract.mjs';
import { createJrpgBlipPcmStream, createJrpgBlipPlan, JRPG_BLIP_VOICE, JRPG_BLIP_VOICES } from './jrpg-blip.mjs';

const STATUS_TOOL = TTS_MCP_TOOLS.status;
const OPEN_TOOL = TTS_MCP_TOOLS.openStream;
const CANCEL_TOOL = TTS_MCP_TOOLS.cancelSynthesis;
const KNOWN_TONE_FIXTURE = 'known-tone-v1';
const KNOWN_TONE_DURATION_MS = 1_600;
const KNOWN_TONE_PULSES = [
  { startMs: 200, endMs: 400, frequencyHz: 660, amplitude: 0.25 },
  { startMs: 600, endMs: 850, frequencyHz: 880, amplitude: 0.55 },
  { startMs: 1_050, endMs: 1_400, frequencyHz: 1_100, amplitude: 0.85 },
];

export function createLocalTtsMcpService(options = {}) {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackHost(host)) throw new TypeError('The reference TTS MCP service may only bind to a loopback host');
  const requestedPort = portNumber(options.port ?? 0);
  const config = Object.freeze({
    delayMs: nonNegative(options.delayMs ?? 15, 'delayMs'),
    defaultRate: synthesisRate(options.defaultRate ?? 1, 'defaultRate'),
    durationPerCharacterMs: positive(options.durationPerCharacterMs ?? 232, 'durationPerCharacterMs'),
    minimumDurationMs: positive(options.minimumDurationMs ?? 500, 'minimumDurationMs'),
    chunkDurationMs: positive(options.chunkDurationMs ?? 20, 'chunkDurationMs'),
    chunkDelayMs: nonNegative(options.chunkDelayMs ?? 1, 'chunkDelayMs'),
    sampleRateHz: positiveInteger(options.sampleRateHz ?? 24_000, 'sampleRateHz'),
    channels: positiveInteger(options.channels ?? 1, 'channels'),
    streamExpiryMs: positive(options.streamExpiryMs ?? 60_000, 'streamExpiryMs'),
  });
  if (config.channels !== 1) throw new RangeError('The reference TTS MCP service currently emits mono PCM only');

  const app = createMcpExpressApp({ host });
  const sessions = new Map();
  const jobsByToken = new Map();
  const tokensByRequest = new Map();
  let httpServer;
  let baseUrl;

  app.use((request, response, next) => {
    const origin = request.headers.origin;
    if (origin && !isAllowedOrigin(origin)) return response.status(403).json({ error: 'origin-not-allowed' });
    if (origin) response.setHeader('access-control-allow-origin', origin);
    response.setHeader('access-control-expose-headers', 'mcp-session-id, mcp-protocol-version');
    response.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    response.setHeader('access-control-allow-headers', 'content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id');
    response.setHeader('vary', 'Origin');
    if (request.method === 'OPTIONS') return response.status(204).end();
    next();
  });

  app.all('/mcp', async (request, response) => {
    try {
      const sessionId = singleHeader(request.headers['mcp-session-id']);
      let record = sessionId ? sessions.get(sessionId) : undefined;
      if (!record && !sessionId && request.method === 'POST' && isInitializeRequest(request.body)) {
        let transport;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized(id) {
            sessions.set(id, record);
          },
          onsessionclosed(id) {
            cleanupSession(id);
          },
        });
        const mcp = createMcpServer();
        record = { mcp, transport };
        transport.onclose = () => {
          if (transport.sessionId) cleanupSession(transport.sessionId);
        };
        await mcp.connect(transport);
      }
      if (!record) {
        return jsonRpcError(response, sessionId ? 404 : 400, sessionId
          ? 'Unknown or expired MCP session'
          : 'A valid MCP initialization request or session ID is required');
      }
      await record.transport.handleRequest(request, response, request.body);
    }
    catch (error) {
      if (!response.headersSent) jsonRpcError(response, 500, error instanceof Error ? error.message : String(error));
      else response.destroy(error instanceof Error ? error : undefined);
    }
  });

  app.get('/audio/:token', async (request, response) => {
    const job = jobsByToken.get(request.params.token);
    if (!job) return response.status(404).json({ error: 'stream-not-found' });
    if (job.claimed) return response.status(409).json({ error: 'stream-already-opened' });
    job.claimed = true;
    clearTimeout(job.expiryTimer);
    response.status(200);
    response.setHeader('content-type', 'audio/pcm');
    response.setHeader('cache-control', 'no-store, no-transform');
    response.setHeader('x-audio-codec', 'pcm_s16le');
    response.setHeader('x-audio-sample-rate-hz', String(job.sampleRateHz));
    response.setHeader('x-audio-channels', String(job.channels));
    response.flushHeaders();

    const onClose = () => {
      if (!response.writableEnded && !job.controller.signal.aborted) {
        job.controller.abort(new DOMException('PCM consumer disconnected', 'AbortError'));
      }
    };
    response.once('close', onClose);
    try {
      for await (const chunk of job.createStream(job.controller.signal)) {
        if (!response.write(chunk)) await once(response, 'drain', { signal: job.controller.signal });
      }
      response.end();
    }
    catch (error) {
      if (!response.destroyed) {
        if (isAbort(error)) response.end();
        else response.destroy(error instanceof Error ? error : undefined);
      }
    }
    finally {
      response.off('close', onClose);
      removeJob(job);
    }
  });

  function createMcpServer() {
    const mcp = new McpServer({ name: 'desktop-char-local-tts', version: '1.0.0' });
    mcp.registerTool(STATUS_TOOL, {
      title: 'Get TTS Provider readiness',
      description: 'Returns the DesktopChar streaming TTS Profile identity and whether this Provider can accept synthesis requests. This call never loads a model or mutates synthesis state.',
      inputSchema: {},
      outputSchema: {
        profile: z.literal(TTS_MCP_PROFILE),
        profile_version: z.literal(TTS_MCP_PROFILE_VERSION),
        provider: z.string().min(1),
        status: z.enum(['ready', 'degraded', 'unavailable']),
        accepting_requests: z.boolean(),
        capabilities: z.object({
          streaming: z.boolean(),
          cancellation: z.boolean(),
          formats: z.array(z.string().min(1)),
          voices: z.array(z.string().min(1)),
          text_cues: z.boolean(),
          test_fixtures: z.array(z.string().min(1)),
        }),
        message: z.string().optional(),
      },
    }, async () => {
      const status = {
        profile: TTS_MCP_PROFILE,
        profile_version: TTS_MCP_PROFILE_VERSION,
        provider: 'desktop-char-local-tts',
        status: 'ready',
        accepting_requests: true,
        capabilities: {
          streaming: true,
          cancellation: true,
          formats: ['pcm_s16le'],
          voices: [...JRPG_BLIP_VOICES],
          text_cues: true,
          test_fixtures: [KNOWN_TONE_FIXTURE],
        },
      };
      return {
        content: [{ type: 'text', text: `${status.provider} ready` }],
        structuredContent: status,
      };
    });
    mcp.registerTool(OPEN_TOOL, {
      title: 'Open streaming TTS audio',
      description: 'Creates a single-use HTTP PCM stream. The reference voice emits one JRPG-style blip per grapheme and returns sample-aligned text cues.',
      inputSchema: {
        request_id: z.string().trim().min(1),
        text: z.string().trim().min(1),
        delivery: z.enum(['stream-required', 'stream-preferred']).default('stream-required'),
        format: z.literal('pcm_s16le').default('pcm_s16le'),
        language: z.string().trim().min(1).optional(),
        voice: z.enum(JRPG_BLIP_VOICES).optional()
          .describe('jrpg-blip is a fixed 560 Hz voice; jrpg-blip-varied deterministically maps graphemes to four pitches.'),
        instruction: z.string().trim().min(1).optional(),
        rate: z.number().min(0.5).max(2).default(config.defaultRate)
          .describe('Speech-rate multiplier. Explicit request values override the service default.'),
        test_fixture: z.literal(KNOWN_TONE_FIXTURE).optional().describe('Development acceptance fixture; omit in production integrations.'),
      },
      outputSchema: {
        stream: z.object({
          request_id: z.string(),
          delivery: z.literal('stream'),
          stream_url: z.string().url(),
          mime_type: z.literal('audio/pcm'),
          codec: z.literal('pcm_s16le'),
          sample_rate_hz: z.number().int().positive(),
          channels: z.number().int().positive(),
          requested_rate: z.number().positive(),
          effective_rate: z.number().positive(),
          rate_mode: z.literal('native'),
          duration_ms: z.number().positive().optional(),
          text_cues: z.array(z.object({
            text: z.string().min(1),
            at_ms: z.number().nonnegative(),
            duration_ms: z.number().positive(),
          })).optional(),
        }),
      },
    }, async (request, extra) => {
      await abortableDelay(config.delayMs, extra.signal);
      if (!baseUrl) throw new Error('TTS MCP HTTP service is not listening');
      const sessionId = extra.sessionId ?? 'stateless';
      const requestKey = keyFor(sessionId, request.request_id);
      if (tokensByRequest.has(requestKey)) throw new Error(`request_id is already active: ${request.request_id}`);

      const token = randomUUID();
      const controller = new AbortController();
      const fixture = request.test_fixture === KNOWN_TONE_FIXTURE;
      const blipPlan = fixture ? undefined : createJrpgBlipPlan(request.text, {
        sampleRateHz: config.sampleRateHz,
        rate: request.rate,
        voice: request.voice ?? JRPG_BLIP_VOICE,
        characterIntervalMs: config.durationPerCharacterMs,
        minimumDurationMs: config.minimumDurationMs,
      });
      const job = {
        token,
        sessionId,
        requestId: request.request_id,
        requestKey,
        claimed: false,
        controller,
        sampleRateHz: config.sampleRateHz,
        channels: config.channels,
        createStream: fixture
          ? signal => createKnownTonePcmStream({ ...config, signal })
          : signal => createJrpgBlipPcmStream(blipPlan, { ...config, signal }),
      };
      job.expiryTimer = setTimeout(() => {
        controller.abort(new DOMException('Unclaimed PCM stream expired', 'AbortError'));
        removeJob(job);
      }, config.streamExpiryMs);
      jobsByToken.set(token, job);
      tokensByRequest.set(requestKey, token);

      const stream = {
        request_id: request.request_id,
        delivery: 'stream',
        stream_url: `${baseUrl}/audio/${token}`,
        mime_type: 'audio/pcm',
        codec: 'pcm_s16le',
        sample_rate_hz: config.sampleRateHz,
        channels: config.channels,
        requested_rate: request.rate,
        effective_rate: request.rate,
        rate_mode: 'native',
        ...(blipPlan ? { duration_ms: blipPlan.durationMs, text_cues: blipPlan.cues } : {}),
      };
      return {
        content: [{ type: 'text', text: `PCM stream ready for request ${request.request_id}` }],
        structuredContent: { stream },
      };
    });

    mcp.registerTool(CANCEL_TOOL, {
      title: 'Cancel streaming TTS audio',
      description: 'Cancels synthesis and disconnects the HTTP PCM stream associated with a request ID.',
      inputSchema: { request_id: z.string().trim().min(1) },
      outputSchema: {
        request_id: z.string(),
        cancelled: z.boolean(),
      },
    }, async (request, extra) => {
      const sessionId = extra.sessionId ?? 'stateless';
      const token = tokensByRequest.get(keyFor(sessionId, request.request_id));
      const job = token ? jobsByToken.get(token) : undefined;
      if (job) {
        job.controller.abort(new DOMException('TTS synthesis cancelled by MCP request', 'AbortError'));
        removeJob(job);
      }
      const result = { request_id: request.request_id, cancelled: Boolean(job) };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    });
    return mcp;
  }

  function cleanupSession(sessionId) {
    sessions.delete(sessionId);
    for (const job of jobsByToken.values()) {
      if (job.sessionId !== sessionId) continue;
      job.controller.abort(new DOMException('MCP session closed', 'AbortError'));
      removeJob(job);
    }
  }

  function removeJob(job) {
    clearTimeout(job.expiryTimer);
    if (jobsByToken.get(job.token) === job) jobsByToken.delete(job.token);
    if (tokensByRequest.get(job.requestKey) === job.token) tokensByRequest.delete(job.requestKey);
  }

  return {
    async listen() {
      if (httpServer) throw new Error('Local TTS MCP service is already listening');
      httpServer = await new Promise((resolve, reject) => {
        const server = app.listen(requestedPort, host);
        server.once('error', reject);
        server.once('listening', () => {
          server.off('error', reject);
          resolve(server);
        });
      });
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('Local TTS MCP service has no TCP address');
      baseUrl = `http://${host === '::1' ? '[::1]' : host}:${address.port}`;
      return { host, port: address.port, baseUrl, mcpUrl: `${baseUrl}/mcp` };
    },
    async close() {
      for (const job of [...jobsByToken.values()]) {
        job.controller.abort(new DOMException('Local TTS MCP service is shutting down', 'AbortError'));
        removeJob(job);
      }
      await Promise.allSettled([...sessions.values()].map(record => record.mcp.close()));
      sessions.clear();
      const server = httpServer;
      httpServer = undefined;
      baseUrl = undefined;
      if (!server) return;
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
    diagnostics() {
      return {
        sessions: sessions.size,
        streams: jobsByToken.size,
        baseUrl: baseUrl ?? null,
        voice: JRPG_BLIP_VOICE,
        voices: JRPG_BLIP_VOICES,
        defaultRate: config.defaultRate,
      };
    },
  };
}

async function* createKnownTonePcmStream(options) {
  const totalFrames = Math.round(KNOWN_TONE_DURATION_MS * options.sampleRateHz / 1_000);
  const chunkFrames = Math.max(1, Math.round(options.chunkDurationMs * options.sampleRateHz / 1_000));
  for (let firstFrame = 0; firstFrame < totalFrames; firstFrame += chunkFrames) {
    throwIfAborted(options.signal);
    if (firstFrame > 0) await abortableDelay(options.chunkDelayMs, options.signal);
    const frameCount = Math.min(chunkFrames, totalFrames - firstFrame);
    const bytes = new Uint8Array(frameCount * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < frameCount; index++) {
      const atMs = (firstFrame + index) / options.sampleRateHz * 1_000;
      const pulse = KNOWN_TONE_PULSES.find(candidate => atMs >= candidate.startMs && atMs < candidate.endMs);
      let value = 0;
      if (pulse) {
        const localMs = atMs - pulse.startMs;
        const remainingMs = pulse.endMs - atMs;
        const fade = Math.min(1, localMs / 12, remainingMs / 12);
        value = Math.sin(2 * Math.PI * pulse.frequencyHz * localMs / 1_000) * pulse.amplitude * fade;
      }
      view.setInt16(index * 2, Math.round(value * 32_767), true);
    }
    yield bytes;
  }
}

function abortableDelay(delayMs, signal) {
  throwIfAborted(signal);
  if (!delayMs) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function isAbort(error) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function keyFor(sessionId, requestId) { return `${sessionId}\0${requestId}`; }
function clamp(value) { return Math.max(-1, Math.min(1, value)); }
function singleHeader(value) { return Array.isArray(value) ? value[0] : value; }
function isLoopbackHost(host) { return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'; }
function isAllowedOrigin(origin) {
  if (origin === 'desktop-char://app') return true;
  try { return isLoopbackHost(new URL(origin).hostname); }
  catch { return false; }
}
function jsonRpcError(response, status, message) {
  return response.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}
function portNumber(value) {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new RangeError('port must be an integer from 0 to 65535');
  return value;
}
function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite`);
  return value;
}
function nonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative and finite`);
  return value;
}
function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function synthesisRate(value, name) {
  if (!Number.isFinite(value) || value < 0.5 || value > 2) throw new RangeError(`${name} must be from 0.5 to 2`);
  return value;
}
