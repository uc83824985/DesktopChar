import type { AudioSource } from '../../contracts/src/index.ts';
import { logEntry, silentTtsLogger, type TtsLogger } from './logging.ts';
import { TtsAdapterError, type TtsAdapter, type TtsCapabilities, type TtsHealthReport, type TtsSynthesisRequest } from './types.ts';

export interface MockTtsOptions {
  delayMs?: number;
  durationPerCharacterMs?: number;
  minimumDurationMs?: number;
  amplitudeIntervalMs?: number;
  delivery?: 'stream' | 'artifact';
  sampleRateHz?: number;
  channels?: number;
  failPattern?: RegExp;
  logger?: TtsLogger;
}

export class MockTtsAdapter implements TtsAdapter {
  private readonly delayMs: number;
  private readonly durationPerCharacterMs: number;
  private readonly minimumDurationMs: number;
  private readonly amplitudeIntervalMs: number;
  private readonly delivery: 'stream' | 'artifact';
  private readonly sampleRateHz: number;
  private readonly channels: number;
  private readonly failPattern: RegExp | undefined;
  private readonly logger: TtsLogger;

  constructor(options: MockTtsOptions = {}) {
    this.delayMs = nonNegative(options.delayMs ?? 15, 'delayMs');
    this.durationPerCharacterMs = positive(options.durationPerCharacterMs ?? 90, 'durationPerCharacterMs');
    this.minimumDurationMs = positive(options.minimumDurationMs ?? 500, 'minimumDurationMs');
    this.amplitudeIntervalMs = positive(options.amplitudeIntervalMs ?? 50, 'amplitudeIntervalMs');
    this.delivery = options.delivery ?? 'stream';
    this.sampleRateHz = positive(options.sampleRateHz ?? 24_000, 'sampleRateHz');
    this.channels = positive(options.channels ?? 1, 'channels');
    this.failPattern = options.failPattern;
    this.logger = options.logger ?? silentTtsLogger;
  }

  async prepare(request: TtsSynthesisRequest): Promise<AudioSource> {
    const text = request.text.trim();
    if (!request.requestId.trim()) throw new TtsAdapterError('tts-invalid-request', 'requestId must not be empty', false);
    if (!text) throw new TtsAdapterError('tts-invalid-request', 'TTS text must not be empty', false);
    const startedAt = performance.now();
    logEntry(this.logger, 'info', 'tts.prepare.started', 'mock', { requestId: request.requestId, data: { textLength: text.length, delivery: request.delivery ?? 'stream-preferred' } });
    try {
      await abortableDelay(this.delayMs, request.signal);
      if (this.failPattern?.test(text)) throw new TtsAdapterError('tts-mock-failure', 'Mock failure pattern matched');
      if (request.delivery === 'stream-required' && this.delivery !== 'stream') {
        throw new TtsAdapterError('tts-stream-unavailable', 'Mock provider is configured for artifact delivery');
      }
      const durationMs = Math.max(this.minimumDurationMs, text.length * this.durationPerCharacterMs);
      const amplitude = Array.from({ length: Math.floor(durationMs / this.amplitudeIntervalMs) + 1 }, (_, index) => ({
        atMs: index * this.amplitudeIntervalMs,
        value: index === 0 || index * this.amplitudeIntervalMs >= durationMs ? 0 : 0.2 + (index % 4) * 0.2,
      }));
      const useStream = request.delivery !== 'artifact' && this.delivery === 'stream';
      const result: AudioSource = useStream
        ? { delivery: 'stream', requestId: request.requestId, uri: `mock://tts/${request.requestId}`, mimeType: 'audio/pcm', codec: 'pcm_s16le', sampleRateHz: this.sampleRateHz, channels: this.channels, durationMs, amplitude }
        : { delivery: 'artifact', requestId: request.requestId, uri: `mock://tts/${request.requestId}.wav`, mimeType: 'audio/wav', codec: 'wav', sampleRateHz: this.sampleRateHz, channels: this.channels, durationMs, amplitude };
      logEntry(this.logger, 'info', 'tts.source.ready', 'mock', { requestId: request.requestId, durationMs: performance.now() - startedAt, data: { delivery: result.delivery, audioDurationMs: durationMs } });
      return result;
    }
    catch (cause) {
      const error = normalizeAbort(cause);
      logEntry(this.logger, error.code === 'tts-aborted' ? 'warn' : 'error', 'tts.prepare.failed', 'mock', { requestId: request.requestId, durationMs: performance.now() - startedAt, data: { code: error.code, message: error.message } });
      throw error;
    }
  }

  async cancel(requestId: string): Promise<void> {
    logEntry(this.logger, 'info', 'tts.cancel.requested', 'mock', { requestId });
  }

  async capabilities(): Promise<TtsCapabilities> {
    return {
      provider: 'mock', formats: ['pcm_s16le', 'wav'],
      deliveryModes: this.delivery === 'stream' ? ['stream', 'artifact'] : ['artifact'],
      supportsVoices: true, supportsLanguages: true, supportsInstructions: true,
      supportsVisemes: false, supportsAmplitude: true,
      streaming: this.delivery === 'stream', cancellation: 'request',
    };
  }

  async health(): Promise<TtsHealthReport> {
    return { status: 'ready', provider: 'mock', latencyMs: 0, details: 'Offline deterministic streaming mock is available' };
  }
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

function normalizeAbort(cause: unknown): TtsAdapterError {
  if (cause instanceof TtsAdapterError) return cause;
  if (cause instanceof DOMException && cause.name === 'AbortError') return new TtsAdapterError('tts-aborted', 'TTS preparation was aborted', true, { cause });
  return new TtsAdapterError('tts-mock-failure', cause instanceof Error ? cause.message : String(cause), true, { cause });
}

function positive(value: number, name: string): number { if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite`); return value; }
function nonNegative(value: number, name: string): number { if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative and finite`); return value; }
