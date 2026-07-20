import type { AmplitudeSample, AudioSource, VisemeTiming } from '../../contracts/src/index.ts';
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
  timeoutMs?: number;
  textArgument?: string;
  voiceArgument?: string;
  rateArgument?: string;
  formatArgument?: string;
  providerName?: string;
  formats?: TtsAudioFormat[];
  supportsVisemes?: boolean;
  supportsAmplitude?: boolean;
  logger?: TtsLogger;
}

export class McpTtsAdapter implements TtsAdapter {
  private readonly client: McpClientPort;
  private readonly toolName: string;
  private readonly timeoutMs: number;
  private readonly argumentNames: { text: string; voice: string; rate: string; format: string };
  private readonly providerName: string;
  private readonly advertisedFormats: TtsAudioFormat[];
  private readonly advertisesVisemes: boolean;
  private readonly advertisesAmplitude: boolean;
  private readonly logger: TtsLogger;
  private requestSequence = 0;

  constructor(options: McpTtsAdapterOptions) {
    this.client = options.client;
    this.toolName = options.toolName ?? 'tts.synthesize';
    this.timeoutMs = positive(options.timeoutMs ?? 30_000, 'timeoutMs');
    this.argumentNames = {
      text: options.textArgument ?? 'text', voice: options.voiceArgument ?? 'voice',
      rate: options.rateArgument ?? 'rate', format: options.formatArgument ?? 'format',
    };
    this.providerName = options.providerName ?? 'mcp';
    this.advertisedFormats = options.formats ?? ['wav', 'mp3', 'ogg', 'pcm'];
    this.advertisesVisemes = options.supportsVisemes ?? false;
    this.advertisesAmplitude = options.supportsAmplitude ?? false;
    this.logger = options.logger ?? silentTtsLogger;
  }

  async synthesize(request: TtsSynthesisRequest): Promise<AudioSource> {
    const text = request.text.trim();
    if (!text) throw new TtsAdapterError('tts-invalid-request', 'TTS text must not be empty', false);
    const requestId = `mcp-${++this.requestSequence}`;
    const startedAt = performance.now();
    const args: Record<string, unknown> = { [this.argumentNames.text]: text };
    if (request.voice) args[this.argumentNames.voice] = request.voice;
    if (request.rate !== undefined) args[this.argumentNames.rate] = request.rate;
    if (request.format) args[this.argumentNames.format] = request.format;
    logEntry(this.logger, 'info', 'tts.synthesis.started', this.providerName, { requestId, data: { tool: this.toolName, textLength: text.length } });
    try {
      const result = await withTimeout(
        signal => this.client.callTool(this.toolName, args, { signal, timeoutMs: this.timeoutMs }),
        this.timeoutMs,
        request.signal,
      );
      if (result.isError) throw new TtsAdapterError('tts-mcp-tool-error', toolErrorMessage(result));
      const audio = normalizeResult(result);
      logEntry(this.logger, 'info', 'tts.synthesis.completed', this.providerName, {
        requestId, durationMs: performance.now() - startedAt,
        data: { tool: this.toolName, audioDurationMs: audio.durationMs, hasVisemes: Boolean(audio.visemes?.length), hasAmplitude: Boolean(audio.amplitude?.length) },
      });
      return audio;
    }
    catch (cause) {
      const error = normalizeMcpError(cause);
      logEntry(this.logger, error.code === 'tts-aborted' ? 'warn' : 'error', 'tts.synthesis.failed', this.providerName, {
        requestId, durationMs: performance.now() - startedAt, data: { tool: this.toolName, code: error.code, message: error.message },
      });
      throw error;
    }
  }

  async capabilities(): Promise<TtsCapabilities> {
    return {
      provider: this.providerName, formats: [...this.advertisedFormats], supportsVoices: true,
      supportsVisemes: this.advertisesVisemes, supportsAmplitude: this.advertisesAmplitude, streaming: false,
    };
  }

  async health(): Promise<TtsHealthReport> {
    const startedAt = performance.now();
    try {
      const tools = await withTimeout(
        signal => this.client.listTools({ signal, timeoutMs: this.timeoutMs }),
        this.timeoutMs,
      );
      const available = tools.some(tool => tool.name === this.toolName);
      const report: TtsHealthReport = {
        status: available ? 'ready' : 'unavailable', provider: this.providerName,
        latencyMs: performance.now() - startedAt,
        details: available ? `MCP tool ${this.toolName} is available` : `MCP tool ${this.toolName} was not advertised`,
      };
      logEntry(this.logger, available ? 'info' : 'error', 'tts.health.checked', this.providerName, { durationMs: report.latencyMs, data: { status: report.status, tool: this.toolName } });
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

function normalizeResult(result: McpCallToolResult): AudioSource {
  const payload = payloadFromStructured(result.structuredContent)
    ?? payloadFromContent(result)
    ?? (() => { throw new TtsAdapterError('tts-mcp-invalid-response', 'MCP result contains no supported audio payload'); })();
  const uri = payload.uri?.trim() || dataUri(payload.data, payload.mimeType);
  if (!uri) throw new TtsAdapterError('tts-mcp-invalid-response', 'Audio payload must include uri or base64 data');
  const audio: AudioSource = { uri };
  if (payload.durationMs !== undefined) audio.durationMs = positive(payload.durationMs, 'durationMs');
  const visemes = normalizeVisemes(payload.visemes);
  const amplitude = normalizeAmplitude(payload.amplitude);
  if (visemes?.length) audio.visemes = visemes;
  if (amplitude?.length) audio.amplitude = amplitude;
  return audio;
}

function payloadFromStructured(value: Record<string, unknown> | undefined): NormalizedTtsPayload | undefined {
  if (!value) return undefined;
  const candidate = isRecord(value.audio) ? value.audio : value;
  return looksLikePayload(candidate) ? candidate as NormalizedTtsPayload : undefined;
}

function payloadFromContent(result: McpCallToolResult): NormalizedTtsPayload | undefined {
  for (const block of result.content) {
    if (block.type === 'audio' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      return { data: block.data, mimeType: block.mimeType };
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      try {
        const parsed: unknown = JSON.parse(block.text);
        if (isRecord(parsed)) {
          const payload = payloadFromStructured(parsed);
          if (payload) return payload;
        }
      }
      catch {}
    }
  }
  return undefined;
}

function normalizeVisemes(value: VisemeTiming[] | undefined): VisemeTiming[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TtsAdapterError('tts-mcp-invalid-response', 'visemes must be an array');
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.viseme !== 'string') throw new TtsAdapterError('tts-mcp-invalid-response', `visemes[${index}] is invalid`);
    const normalized: VisemeTiming = { atMs: nonNegativeNumber(item.atMs, `visemes[${index}].atMs`), durationMs: positiveNumber(item.durationMs, `visemes[${index}].durationMs`), viseme: item.viseme };
    if (item.weight !== undefined) normalized.weight = clamp01(number(item.weight, `visemes[${index}].weight`));
    return normalized;
  }).sort((a, b) => a.atMs - b.atMs);
}

function normalizeAmplitude(value: AmplitudeSample[] | undefined): AmplitudeSample[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TtsAdapterError('tts-mcp-invalid-response', 'amplitude must be an array');
  return value.map((item, index) => {
    if (!isRecord(item)) throw new TtsAdapterError('tts-mcp-invalid-response', `amplitude[${index}] is invalid`);
    return { atMs: nonNegativeNumber(item.atMs, `amplitude[${index}].atMs`), value: clamp01(number(item.value, `amplitude[${index}].value`)) };
  }).sort((a, b) => a.atMs - b.atMs);
}

function dataUri(data: string | undefined, mimeType: string | undefined): string | undefined {
  if (!data) return undefined;
  if (!mimeType?.startsWith('audio/')) throw new TtsAdapterError('tts-mcp-invalid-response', 'Base64 audio requires an audio/* mimeType');
  return `data:${mimeType};base64,${data}`;
}

function looksLikePayload(value: Record<string, unknown>): boolean { return typeof value.uri === 'string' || typeof value.data === 'string'; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function toolErrorMessage(result: McpCallToolResult): string { return result.content.map(block => block.type === 'text' && typeof block.text === 'string' ? block.text : '').filter(Boolean).join('; ') || 'MCP TTS tool reported an error'; }
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function number(value: unknown, name: string): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new TtsAdapterError('tts-mcp-invalid-response', `${name} must be finite`); return value; }
function positiveNumber(value: unknown, name: string): number { const result = number(value, name); if (result <= 0) throw new TtsAdapterError('tts-mcp-invalid-response', `${name} must be positive`); return result; }
function nonNegativeNumber(value: unknown, name: string): number { const result = number(value, name); if (result < 0) throw new TtsAdapterError('tts-mcp-invalid-response', `${name} must be non-negative`); return result; }
function positive(value: number, name: string): number { if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite`); return value; }

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, callerSignal?: AbortSignal): Promise<T> {
  if (callerSignal?.aborted) throw new TtsAdapterError('tts-aborted', 'TTS synthesis was aborted');
  const controller = new AbortController();
  const onAbort = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(new Error('timeout')); }, timeoutMs);
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<T>((_, reject) => controller.signal.addEventListener('abort', () => reject(new TtsAdapterError(timedOut ? 'tts-timeout' : 'tts-aborted', timedOut ? `TTS request timed out after ${timeoutMs} ms` : 'TTS synthesis was aborted')), { once: true })),
    ]);
  }
  finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', onAbort);
  }
}

function normalizeMcpError(cause: unknown): TtsAdapterError {
  if (cause instanceof TtsAdapterError) return cause;
  return new TtsAdapterError('tts-mcp-transport-error', cause instanceof Error ? cause.message : String(cause), true, { cause });
}
