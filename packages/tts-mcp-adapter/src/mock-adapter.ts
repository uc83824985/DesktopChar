import type { AudioSource } from '../../contracts/src/index.ts';
import { logEntry, silentTtsLogger, type TtsLogger } from './logging.ts';
import { TtsAdapterError, type TtsAdapter, type TtsCapabilities, type TtsHealthReport, type TtsSynthesisRequest } from './types.ts';

export interface MockTtsOptions {
  delayMs?: number;
  durationPerCharacterMs?: number;
  minimumDurationMs?: number;
  amplitudeIntervalMs?: number;
  failPattern?: RegExp;
  logger?: TtsLogger;
}

export class MockTtsAdapter implements TtsAdapter {
  private readonly delayMs: number;
  private readonly durationPerCharacterMs: number;
  private readonly minimumDurationMs: number;
  private readonly amplitudeIntervalMs: number;
  private readonly failPattern: RegExp | undefined;
  private readonly logger: TtsLogger;
  private requestSequence = 0;

  constructor(options: MockTtsOptions = {}) {
    this.delayMs = nonNegative(options.delayMs ?? 15, 'delayMs');
    this.durationPerCharacterMs = positive(options.durationPerCharacterMs ?? 90, 'durationPerCharacterMs');
    this.minimumDurationMs = positive(options.minimumDurationMs ?? 500, 'minimumDurationMs');
    this.amplitudeIntervalMs = positive(options.amplitudeIntervalMs ?? 50, 'amplitudeIntervalMs');
    this.failPattern = options.failPattern;
    this.logger = options.logger ?? silentTtsLogger;
  }

  async synthesize(request: TtsSynthesisRequest): Promise<AudioSource> {
    const text = request.text.trim();
    if (!text) throw new TtsAdapterError('tts-invalid-request', 'TTS text must not be empty', false);
    const requestId = `mock-${++this.requestSequence}`;
    const startedAt = performance.now();
    logEntry(this.logger, 'info', 'tts.synthesis.started', 'mock', { requestId, data: { textLength: text.length, voice: request.voice ?? 'mock-default' } });
    try {
      await abortableDelay(this.delayMs, request.signal);
      if (this.failPattern?.test(text)) throw new TtsAdapterError('tts-mock-failure', 'Mock failure pattern matched');
      const durationMs = Math.max(this.minimumDurationMs, text.length * this.durationPerCharacterMs);
      const amplitude = Array.from({ length: Math.floor(durationMs / this.amplitudeIntervalMs) + 1 }, (_, index) => ({
        atMs: index * this.amplitudeIntervalMs,
        value: index === 0 || index * this.amplitudeIntervalMs >= durationMs ? 0 : 0.2 + (index % 4) * 0.2,
      }));
      const result = { uri: `mock://tts/${requestId}`, durationMs, amplitude };
      logEntry(this.logger, 'info', 'tts.synthesis.completed', 'mock', { requestId, durationMs: performance.now() - startedAt, data: { audioDurationMs: durationMs, samples: amplitude.length } });
      return result;
    }
    catch (cause) {
      const error = normalizeAbort(cause);
      logEntry(this.logger, error.code === 'tts-aborted' ? 'warn' : 'error', 'tts.synthesis.failed', 'mock', { requestId, durationMs: performance.now() - startedAt, data: { code: error.code, message: error.message } });
      throw error;
    }
  }

  async capabilities(): Promise<TtsCapabilities> {
    return { provider: 'mock', formats: ['wav'], supportsVoices: true, supportsVisemes: false, supportsAmplitude: true, streaming: false };
  }

  async health(): Promise<TtsHealthReport> {
    return { status: 'ready', provider: 'mock', latencyMs: 0, details: 'Offline deterministic mock is available' };
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
  if (cause instanceof DOMException && cause.name === 'AbortError') return new TtsAdapterError('tts-aborted', 'TTS synthesis was aborted', true, { cause });
  return new TtsAdapterError('tts-mock-failure', cause instanceof Error ? cause.message : String(cause), true, { cause });
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite`);
  return value;
}
function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative and finite`);
  return value;
}
