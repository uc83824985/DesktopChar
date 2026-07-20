import type { AmplitudeSample, AudioCodec, AudioSource, VisemeTiming } from '../../contracts/src/index.ts';

export type TtsAudioFormat = 'wav' | 'mp3' | 'ogg' | 'opus' | 'pcm_s16le' | 'pcm_f32le';
export type TtsDeliveryPreference = 'stream-required' | 'stream-preferred' | 'artifact';

export interface TtsSynthesisRequest {
  requestId: string;
  text: string;
  delivery?: TtsDeliveryPreference;
  voice?: string;
  language?: string;
  instruction?: string;
  rate?: number;
  format?: TtsAudioFormat;
  signal?: AbortSignal;
}

export interface TtsCapabilities {
  provider: string;
  formats: TtsAudioFormat[];
  deliveryModes: Array<'stream' | 'artifact'>;
  supportsVoices: boolean;
  supportsLanguages: boolean;
  supportsInstructions: boolean;
  supportsVisemes: boolean;
  supportsAmplitude: boolean;
  streaming: boolean;
  cancellation: 'none' | 'request';
}

export interface TtsHealthReport {
  status: 'ready' | 'degraded' | 'unavailable';
  provider: string;
  latencyMs: number;
  details: string;
}

export interface TtsAdapter {
  prepare(request: TtsSynthesisRequest): Promise<AudioSource>;
  cancel(requestId: string): Promise<void>;
  capabilities(): Promise<TtsCapabilities>;
  health(): Promise<TtsHealthReport>;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export type McpContentBlock =
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'text'; text: string }
  | { type: string; [key: string]: unknown };

export interface McpCallToolResult {
  content: McpContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpCallOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface McpClientPort {
  listTools(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>, options: McpCallOptions): Promise<McpCallToolResult>;
}

export interface NormalizedTtsPayload {
  requestId?: string;
  delivery?: 'stream' | 'artifact';
  uri?: string;
  data?: string;
  mimeType?: string;
  codec?: AudioCodec;
  sampleRateHz?: number;
  channels?: number;
  durationMs?: number;
  visemes?: VisemeTiming[];
  amplitude?: AmplitudeSample[];
}

export class TtsAdapterError extends Error {
  readonly code: string;
  readonly recoverable: boolean;

  constructor(code: string, message: string, recoverable = true, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TtsAdapterError';
    this.code = code;
    this.recoverable = recoverable;
  }
}
