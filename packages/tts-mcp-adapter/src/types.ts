import type { AmplitudeSample, AudioSource, VisemeTiming } from '../../contracts/src/index.ts';

export type TtsAudioFormat = 'wav' | 'mp3' | 'ogg' | 'pcm';

export interface TtsSynthesisRequest {
  text: string;
  voice?: string;
  rate?: number;
  format?: TtsAudioFormat;
  signal?: AbortSignal;
}

export interface TtsCapabilities {
  provider: string;
  formats: TtsAudioFormat[];
  supportsVoices: boolean;
  supportsVisemes: boolean;
  supportsAmplitude: boolean;
  streaming: boolean;
}

export interface TtsHealthReport {
  status: 'ready' | 'degraded' | 'unavailable';
  provider: string;
  latencyMs: number;
  details: string;
}

export interface TtsAdapter {
  synthesize(request: TtsSynthesisRequest): Promise<AudioSource>;
  capabilities(): Promise<TtsCapabilities>;
  health(): Promise<TtsHealthReport>;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
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
  uri?: string;
  data?: string;
  mimeType?: string;
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
