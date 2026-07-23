import type {
  LocalPerformanceSuggestion,
  PerformanceInferenceCapabilities,
  PerformancePlanningRequest,
} from '../../contracts/src/index.ts';
import type { PerformanceInferencePort } from './port.ts';
import { PerformanceInferenceError } from './port.ts';

export interface FallbackPerformanceInferenceOptions {
  onFallback?(
    error: unknown,
    request: PerformancePlanningRequest,
  ): void;
}

export class FallbackPerformanceInference implements PerformanceInferencePort {
  private readonly primary: PerformanceInferencePort;
  private readonly fallback: PerformanceInferencePort;
  private readonly options: FallbackPerformanceInferenceOptions;

  constructor(
    primary: PerformanceInferencePort,
    fallback: PerformanceInferencePort,
    options: FallbackPerformanceInferenceOptions = {},
  ) {
    this.primary = primary;
    this.fallback = fallback;
    this.options = options;
  }

  describe(): PerformanceInferenceCapabilities {
    return this.primary.describe();
  }

  async plan(
    request: PerformancePlanningRequest,
    signal: AbortSignal,
  ): Promise<LocalPerformanceSuggestion> {
    try {
      return await this.primary.plan(request, signal);
    }
    catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof PerformanceInferenceError && !error.recoverable) throw error;
      this.options.onFallback?.(error, request);
      return await this.fallback.plan(request, signal);
    }
  }
}
