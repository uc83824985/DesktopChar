import type { AmplitudeSample, AudioCodec, AudioSource, VisemeTiming } from '../../contracts/src/index.ts';
import { logEntry, silentTtsLogger, type TtsLogger } from './logging.ts';
import {
  TtsAdapterError,
  type McpCallToolResult,
  type McpClientPort,
  type NormalizedTtsPayload,
  type TtsAdapter,
  type TtsAudioFormat,
  type TtsCapabilities,
  type TtsHealthReport,
  type TtsSynthesisRequest,
} from './types.ts';

export interface McpTtsAdapterOptions {
  client: McpClientPort;
  toolName?: string;
  cancelToolName?: string;
  timeoutMs?: number;
  requestIdArgument?: string;
  textArgument?: string;
  deliveryArgument?: string;
  voiceArgument?: string;
  languageArgument?: string;
  instructionArgument?: string;
  rateArgument?: string;
  formatArgument?: string;
  providerName?: string;
  formats?: TtsAudioFormat[];
  deliveryModes?: Array<'stream' | 'artifact'>;
  supportsVisemes?: boolean;
  supportsAmplitude?: boolean;
  logger?: TtsLogger;
}

export class McpTtsAdapter implements TtsAdapter {
  private readonly client: McpClientPort;
  private readonly toolName: string;
  private readonly cancelToolName: string | undefined;
  private readonly timeoutMs: number;
  private readonly argumentNames: Record<'requestId' | 'text' | 'delivery' | 'voice' | 'language' | 'instruction' | 'rate' | 'format', string>;
  private readonly providerName: string;
  private readonly advertisedFormats: TtsAudioFormat[];
  private readonly deliveryModes: Array<'stream' | 'artifact'>;
  private readonly advertisesVisemes: boolean;
  private readonly advertisesAmplitude: boolean;
  private readonly logger: TtsLogger;

  constructor(options: McpTtsAdapterOptions) {
    this.client = options.client;
    this.toolName = options.toolName ?? 'tts_open_stream';
    this.cancelToolName = options.cancelToolName ?? 'tts_cancel_synthesis';
    this.timeoutMs = positive(options.timeoutMs ?? 30_000, 'timeoutMs');
    this.argumentNames = {
      requestId: options.requestIdArgument ?? 'request_id', text: options.textArgument ?? 'text',
      delivery: options.deliveryArgument ?? 'delivery', voice: options.voiceArgument ?? 'voice',
      language: options.languageArgument ?? 'language', instruction: options.instructionArgument ?? 'instruction',
      rate: options.rateArgument ?? 'rate', format: options.formatArgument ?? 'format',
    };
    this.providerName = options.providerName ?? 'mcp';
    this.advertisedFormats = options.formats ?? ['pcm_s16le', 'wav'];
    this.deliveryModes = options.deliveryModes ?? ['stream', 'artifact'];
    this.advertisesVisemes = options.supportsVisemes ?? false;
    this.advertisesAmplitude = options.supportsAmplitude ?? true;
    this.logger = options.logger ?? silentTtsLogger;
  }

  async prepare(request: TtsSynthesisRequest): Promise<AudioSource> {
    const text = request.text.trim();
    if (!request.requestId.trim()) throw new TtsAdapterError('tts-invalid-request', 'requestId must not be empty', false);
    if (!text) throw new TtsAdapterError('tts-invalid-request', 'TTS text must not be empty', false);
    const startedAt = performance.now();
    const args: Record<string, unknown> = {
      [this.argumentNames.requestId]: request.requestId,
      [this.argumentNames.text]: text,
      [this.argumentNames.delivery]: request.delivery ?? 'stream-preferred',
    };
    if (request.voice) args[this.argumentNames.voice] = request.voice;
    if (request.language) args[this.argumentNames.language] = request.language;
    if (request.instruction) args[this.argumentNames.instruction] = request.instruction;
    if (request.rate !== undefined) args[this.argumentNames.rate] = request.rate;
    if (request.format) args[this.argumentNames.format] = request.format;
    logEntry(this.logger, 'info', 'tts.prepare.started', this.providerName, { requestId: request.requestId, data: { tool: this.toolName, textLength: text.length, delivery: request.delivery ?? 'stream-preferred' } });
    try {
      const result = await withTimeout(
        signal => this.client.callTool(this.toolName, args, { signal, timeoutMs: this.timeoutMs }),
        this.timeoutMs,
        request.signal,
      );
      if (result.isError) throw new TtsAdapterError('tts-mcp-tool-error', toolErrorMessage(result));
      const audio = normalizeResult(result, request);
      logEntry(this.logger, 'info', 'tts.source.ready', this.providerName, {
        requestId: request.requestId, durationMs: performance.now() - startedAt,
        data: { tool: this.toolName, delivery: audio.delivery, audioDurationMs: audio.durationMs, hasVisemes: Boolean(audio.visemes?.length), hasAmplitude: Boolean(audio.amplitude?.length) },
      });
      return audio;
    }
    catch (cause) {
      const error = normalizeMcpError(cause);
      logEntry(this.logger, error.code === 'tts-aborted' ? 'warn' : 'error', 'tts.prepare.failed', this.providerName, {
        requestId: request.requestId, durationMs: performance.now() - startedAt,
        data: { tool: this.toolName, code: error.code, message: error.message },
      });
      throw error;
    }
  }

  async cancel(requestId: string): Promise<void> {
    if (!this.cancelToolName) return;
    const result = await withTimeout(
      signal => this.client.callTool(this.cancelToolName!, { [this.argumentNames.requestId]: requestId }, { signal, timeoutMs: this.timeoutMs }),
      this.timeoutMs,
    );
    if (result.isError) throw new TtsAdapterError('tts-mcp-cancel-error', toolErrorMessage(result));
    logEntry(this.logger, 'info', 'tts.cancel.requested', this.providerName, { requestId, data: { tool: this.cancelToolName } });
  }

  async capabilities(): Promise<TtsCapabilities> {
    return {
      provider: this.providerName, formats: [...this.advertisedFormats], deliveryModes: [...this.deliveryModes],
      supportsVoices: true, supportsLanguages: true, supportsInstructions: true,
      supportsVisemes: this.advertisesVisemes, supportsAmplitude: this.advertisesAmplitude,
      streaming: this.deliveryModes.includes('stream'), cancellation: this.cancelToolName ? 'request' : 'none',
    };
  }

  async health(): Promise<TtsHealthReport> {
    const startedAt = performance.now();
    try {
      const tools = await withTimeout(signal => this.client.listTools({ signal, timeoutMs: this.timeoutMs }), this.timeoutMs);
      const synthesis = tools.find(tool => tool.name === this.toolName);
      const available = Boolean(synthesis);
      const schemaKnown = Boolean(synthesis?.outputSchema);
      const report: TtsHealthReport = {
        status: available ? (schemaKnown ? 'ready' : 'degraded') : 'unavailable', provider: this.providerName,
        latencyMs: performance.now() - startedAt,
        details: available
          ? (schemaKnown ? `MCP streaming tool ${this.toolName} is available` : `MCP tool ${this.toolName} is available but has no output schema`)
          : `MCP tool ${this.toolName} was not advertised`,
      };
      logEntry(this.logger, report.status === 'unavailable' ? 'error' : report.status === 'degraded' ? 'warn' : 'info', 'tts.health.checked', this.providerName, { durationMs: report.latencyMs, data: { status: report.status, tool: this.toolName } });
      return report;
    }
    catch (cause) {
      const error = normalizeMcpError(cause);
      const report = { status: 'unavailable' as const, provider: this.providerName, latencyMs: performance.now() - startedAt, details: `${error.code}: ${error.message}` };
      logEntry(this.logger, 'error', 'tts.health.checked', this.providerName, { durationMs: report.latencyMs, data: { status: report.status, code: error.code } });
      return report;
    }
  }
}

function normalizeResult(result: McpCallToolResult, request: TtsSynthesisRequest): AudioSource {
  const payload = payloadFromStructured(result.structuredContent) ?? payloadFromContent(result);
  if (!payload) throw new TtsAdapterError('tts-mcp-invalid-response', 'MCP result contains no supported audio or stream payload');
  const uri = payload.uri?.trim() || dataUri(payload.data, payload.mimeType);
  if (!uri) throw new TtsAdapterError('tts-mcp-invalid-response', 'Audio payload must include uri, stream URL, or base64 data');
  const delivery = payload.data ? 'artifact' : payload.delivery ?? 'artifact';
  if (request.delivery === 'stream-required' && delivery !== 'stream') {
    throw new TtsAdapterError('tts-stream-unavailable', 'MCP provider returned an artifact for a stream-required request');
  }
  const requestId = payload.requestId ?? request.requestId;
  if (requestId !== request.requestId) {
    throw new TtsAdapterError('tts-request-mismatch', `MCP provider returned request ${requestId} for ${request.requestId}`);
  }
  const mimeType = payload.mimeType ?? mimeTypeOf(payload.codec, delivery);
  const visemes = normalizeVisemes(payload.visemes);
  const amplitude = normalizeAmplitude(payload.amplitude);
  const common = {
    delivery, requestId, uri, mimeType,
    ...(payload.durationMs !== undefined ? { durationMs: positive(payload.durationMs, 'durationMs') } : {}),
    ...(visemes ? { visemes } : {}),
    ...(amplitude ? { amplitude } : {}),
  };
  if (delivery === 'stream') {
    const codec = payload.codec ?? codecOf(mimeType);
    if (!codec) throw new TtsAdapterError('tts-mcp-invalid-response', 'Streaming audio requires a supported codec');
    const sampleRateHz = positive(payload.sampleRateHz ?? 0, 'sampleRateHz');
    const channels = positive(payload.channels ?? 0, 'channels');
    return { ...common, delivery: 'stream', codec, sampleRateHz, channels };
  }
  return {
    ...common, delivery: 'artifact',
    ...(payload.codec ? { codec: payload.codec } : {}),
    ...(payload.sampleRateHz !== undefined ? { sampleRateHz: positive(payload.sampleRateHz, 'sampleRateHz') } : {}),
    ...(payload.channels !== undefined ? { channels: positive(payload.channels, 'channels') } : {}),
  };
}

function payloadFromStructured(value: Record<string, unknown> | undefined): NormalizedTtsPayload | undefined {
  if (!value) return undefined;
  const candidate = isRecord(value.stream) ? value.stream : isRecord(value.audio) ? value.audio : value;
  return payloadFromRecord(candidate);
}

function payloadFromRecord(value: Record<string, unknown>): NormalizedTtsPayload | undefined {
  const uri = stringField(value, 'uri', 'streamUrl', 'stream_url', 'audioUrl', 'audio_url');
  const data = stringField(value, 'data');
  if (!uri && !data) return undefined;
  const deliveryValue = stringField(value, 'delivery');
  const codecValue = stringField(value, 'codec', 'format');
  const payload: NormalizedTtsPayload = {};
  const requestId = stringField(value, 'requestId', 'request_id');
  const mimeType = stringField(value, 'mimeType', 'mime_type');
  if (requestId) payload.requestId = requestId;
  if (deliveryValue === 'stream' || deliveryValue === 'artifact') payload.delivery = deliveryValue;
  else if (stringField(value, 'streamUrl', 'stream_url')) payload.delivery = 'stream';
  if (uri) payload.uri = uri;
  if (data) payload.data = data;
  if (mimeType) payload.mimeType = mimeType;
  const codec = audioCodec(codecValue);
  if (codec) payload.codec = codec;
  const sampleRateHz = numberField(value, 'sampleRateHz', 'sample_rate_hz', 'sampleRate', 'sample_rate');
  const channels = numberField(value, 'channels');
  const durationMs = numberField(value, 'durationMs', 'duration_ms');
  if (sampleRateHz !== undefined) payload.sampleRateHz = sampleRateHz;
  if (channels !== undefined) payload.channels = channels;
  if (durationMs !== undefined) payload.durationMs = durationMs;
  if (Array.isArray(value.visemes)) payload.visemes = value.visemes as VisemeTiming[];
  if (Array.isArray(value.amplitude)) payload.amplitude = value.amplitude as AmplitudeSample[];
  return payload;
}

function payloadFromContent(result: McpCallToolResult): NormalizedTtsPayload | undefined {
  for (const block of result.content) {
    if (block.type === 'audio' && typeof block.data === 'string' && typeof block.mimeType === 'string') return { data: block.data, mimeType: block.mimeType, delivery: 'artifact' };
    if (block.type === 'text' && typeof block.text === 'string') {
      try { const parsed: unknown = JSON.parse(block.text); if (isRecord(parsed)) { const payload = payloadFromStructured(parsed); if (payload) return payload; } }
      catch {}
    }
  }
  return undefined;
}

function normalizeVisemes(value: VisemeTiming[] | undefined): VisemeTiming[] | undefined {
  if (value === undefined) return undefined;
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.viseme !== 'string') throw new TtsAdapterError('tts-mcp-invalid-response', `visemes[${index}] is invalid`);
    const normalized: VisemeTiming = {
      atMs: nonNegativeNumber(numberField(item, 'atMs', 'at_ms'), `visemes[${index}].atMs`),
      durationMs: positiveNumber(numberField(item, 'durationMs', 'duration_ms'), `visemes[${index}].durationMs`), viseme: item.viseme,
    };
    const weight = numberField(item, 'weight'); if (weight !== undefined) normalized.weight = clamp01(weight);
    return normalized;
  }).sort((a, b) => a.atMs - b.atMs);
}

function normalizeAmplitude(value: AmplitudeSample[] | undefined): AmplitudeSample[] | undefined {
  if (value === undefined) return undefined;
  return value.map((item, index) => {
    if (!isRecord(item)) throw new TtsAdapterError('tts-mcp-invalid-response', `amplitude[${index}] is invalid`);
    return { atMs: nonNegativeNumber(numberField(item, 'atMs', 'at_ms'), `amplitude[${index}].atMs`), value: clamp01(numberRequired(item.value, `amplitude[${index}].value`)) };
  }).sort((a, b) => a.atMs - b.atMs);
}

function dataUri(data: string | undefined, mimeType: string | undefined): string | undefined {
  if (!data) return undefined;
  if (!mimeType?.startsWith('audio/')) throw new TtsAdapterError('tts-mcp-invalid-response', 'Base64 audio requires an audio/* mimeType');
  return `data:${mimeType};base64,${data}`;
}
function mimeTypeOf(codec: AudioCodec | undefined, delivery: 'stream' | 'artifact'): string { if (codec?.startsWith('pcm_')) return 'audio/pcm'; return codec ? `audio/${codec}` : delivery === 'stream' ? 'audio/pcm' : 'audio/wav'; }
function codecOf(mimeType: string): AudioCodec | undefined { return mimeType === 'audio/pcm' ? 'pcm_s16le' : audioCodec(mimeType.replace(/^audio\//, '')); }
function audioCodec(value: string | undefined): AudioCodec | undefined { return value === 'pcm_s16le' || value === 'pcm_f32le' || value === 'wav' || value === 'mp3' || value === 'ogg' || value === 'opus' ? value : undefined; }
function stringField(value: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const field = value[name];
    if (typeof field === 'string') return field;
  }
  return undefined;
}
function numberField(value: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const field = value[name];
    if (typeof field === 'number' && Number.isFinite(field)) return field;
  }
  return undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function toolErrorMessage(result: McpCallToolResult): string { return result.content.map(block => block.type === 'text' && typeof block.text === 'string' ? block.text : '').filter(Boolean).join('; ') || 'MCP TTS tool reported an error'; }
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function numberRequired(value: unknown, name: string): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new TtsAdapterError('tts-mcp-invalid-response', `${name} must be finite`); return value; }
function positiveNumber(value: number | undefined, name: string): number { return positive(value ?? 0, name); }
function nonNegativeNumber(value: number | undefined, name: string): number { const result = numberRequired(value, name); if (result < 0) throw new TtsAdapterError('tts-mcp-invalid-response', `${name} must be non-negative`); return result; }
function positive(value: number, name: string): number { if (!Number.isFinite(value) || value <= 0) throw new TtsAdapterError('tts-mcp-invalid-response', `${name} must be positive and finite`); return value; }

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, callerSignal?: AbortSignal): Promise<T> {
  if (callerSignal?.aborted) throw new TtsAdapterError('tts-aborted', 'TTS preparation was aborted');
  const controller = new AbortController(); const onAbort = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener('abort', onAbort, { once: true }); let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(new Error('timeout')); }, timeoutMs);
  try {
    return await Promise.race([operation(controller.signal), new Promise<T>((_, reject) => controller.signal.addEventListener('abort', () => reject(new TtsAdapterError(timedOut ? 'tts-timeout' : 'tts-aborted', timedOut ? `TTS request timed out after ${timeoutMs} ms` : 'TTS preparation was aborted')), { once: true }))]);
  }
  finally { clearTimeout(timeout); callerSignal?.removeEventListener('abort', onAbort); }
}

function normalizeMcpError(cause: unknown): TtsAdapterError { return cause instanceof TtsAdapterError ? cause : new TtsAdapterError('tts-mcp-transport-error', cause instanceof Error ? cause.message : String(cause), true, { cause }); }
