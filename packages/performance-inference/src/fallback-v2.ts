import type {
  LocalPerformanceSuggestionV2,
  PerformanceInferenceCapabilities,
  PerformancePlanningRequestV2,
} from '../../contracts/src/index.ts';
import { PerformanceInferenceError } from './port.ts';
import type { PerformanceInferencePortV2 } from './v2-port.ts';

export interface FallbackPerformanceInferenceV2Options {
  onFallback?(error: unknown, request: PerformancePlanningRequestV2): void;
}

export class FallbackPerformanceInferenceV2 implements PerformanceInferencePortV2 {
  private readonly primary: PerformanceInferencePortV2;
  private readonly fallback: PerformanceInferencePortV2;
  private readonly options: FallbackPerformanceInferenceV2Options;

  constructor(
    primary: PerformanceInferencePortV2,
    fallback: PerformanceInferencePortV2,
    options: FallbackPerformanceInferenceV2Options = {},
  ) {
    this.primary = primary;
    this.fallback = fallback;
    this.options = options;
  }

  describe(): PerformanceInferenceCapabilities {
    return this.primary.describe();
  }

  async plan(
    request: PerformancePlanningRequestV2,
    signal: AbortSignal,
  ): Promise<LocalPerformanceSuggestionV2> {
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
