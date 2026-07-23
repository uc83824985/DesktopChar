import type {
  LocalPerformanceSuggestion,
  PerformanceInferenceCapabilities,
  PerformancePlanningRequest,
} from '../../contracts/src/index.ts';

export interface PerformanceInferencePort {
  describe(): PerformanceInferenceCapabilities;
  plan(
    request: PerformancePlanningRequest,
    signal: AbortSignal,
  ): Promise<LocalPerformanceSuggestion>;
}

export class PerformanceInferenceError extends Error {
  readonly code: string;
  readonly recoverable: boolean;

  constructor(code: string, message: string, options: { recoverable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'PerformanceInferenceError';
    this.code = code;
    this.recoverable = options.recoverable ?? true;
  }
}
