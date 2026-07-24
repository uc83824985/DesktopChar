import type { PerformanceInferenceCapabilities } from '../../contracts/src/index.ts';
import { PerformanceInferenceError } from './port.ts';

export interface PerformanceModelRequest {
  instructions: string;
  input: string;
  maxOutputTokens: number;
  temperature: number;
}

export interface PerformanceModelResponse {
  provider: string;
  text: string;
}

/**
 * Raw text-generation boundary. Implementations may use a local small model,
 * a remote service, an in-process engine, or a deterministic fixture.
 */
export interface PerformanceModelTransport {
  describe(): PerformanceInferenceCapabilities;
  complete(
    request: PerformanceModelRequest,
    signal: AbortSignal,
  ): Promise<PerformanceModelResponse>;
}

export interface OpenAiCompatibleTransportConfig {
  provider: string;
  baseUrl: string;
  model?: string;
  timeoutMs: number;
}

export class OpenAiCompatiblePerformanceTransport implements PerformanceModelTransport {
  private readonly config: OpenAiCompatibleTransportConfig;
  private readonly fetcher: typeof fetch;

  constructor(config: OpenAiCompatibleTransportConfig, fetcher: typeof fetch = fetch) {
    validateConfig(config);
    this.config = { ...config, baseUrl: config.baseUrl.replace(/\/+$/u, '') };
    this.fetcher = (input, init) => Reflect.apply(fetcher, globalThis, [input, init]);
  }

  describe(): PerformanceInferenceCapabilities {
    return {
      structuredOutput: 'prompt-only',
      thinkingControl: 'unsupported',
      streaming: false,
    };
  }

  async complete(
    request: PerformanceModelRequest,
    signal: AbortSignal,
  ): Promise<PerformanceModelResponse> {
    if (signal.aborted) throw abortedError(signal.reason);
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.timeoutMs);
    try {
      const body: Record<string, unknown> = {
        messages: [
          { role: 'system', content: request.instructions },
          { role: 'user', content: request.input },
        ],
        max_tokens: request.maxOutputTokens,
        temperature: request.temperature,
        stream: false,
      };
      if (this.config.model !== undefined) body.model = this.config.model;
      const response = await this.fetcher(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const details = (await response.text()).slice(0, 500);
        throw new PerformanceInferenceError(
          'performance-http-error',
          `Performance Provider returned HTTP ${response.status}${details ? `: ${details}` : ''}`,
        );
      }
      return {
        provider: this.config.provider,
        text: chatContent(await response.json()),
      };
    }
    catch (cause) {
      if (cause instanceof PerformanceInferenceError) throw cause;
      if (signal.aborted) throw abortedError(signal.reason);
      if (timedOut) {
        throw new PerformanceInferenceError(
          'performance-timeout',
          `Performance inference exceeded ${this.config.timeoutMs}ms`,
          { cause },
        );
      }
      throw new PerformanceInferenceError(
        'performance-provider-failure',
        cause instanceof Error ? cause.message : String(cause),
        { cause },
      );
    }
    finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
}

function chatContent(value: unknown): string {
  const root = record(value, 'chat completion');
  if (!Array.isArray(root.choices) || !root.choices.length) {
    throw invalidResponse('Chat completion has no choices');
  }
  const choice = record(root.choices[0], 'chat completion choice');
  const message = record(choice.message, 'chat completion message');
  if (typeof message.content !== 'string' || !message.content.trim()) {
    throw invalidResponse('Chat completion content must be a non-empty string');
  }
  return message.content;
}

function validateConfig(config: OpenAiCompatibleTransportConfig): void {
  if (!config.provider.trim()) throw new TypeError('Performance Provider name is required');
  const url = new URL(config.baseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Performance Provider baseUrl must use HTTP or HTTPS');
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new TypeError('Performance Provider timeoutMs must be positive');
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidResponse(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function invalidResponse(message: string): PerformanceInferenceError {
  return new PerformanceInferenceError('performance-invalid-response', message);
}

function abortedError(cause: unknown): PerformanceInferenceError {
  return new PerformanceInferenceError(
    'performance-aborted',
    'Performance inference was cancelled',
    { cause },
  );
}
