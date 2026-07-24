import type {
  LocalPerformanceSuggestionV2,
  PerformanceInferenceCapabilities,
  PerformancePlanningRequestV2,
} from '../../contracts/src/index.ts';

export interface PerformanceInferencePortV2 {
  describe(): PerformanceInferenceCapabilities;
  plan(
    request: PerformancePlanningRequestV2,
    signal: AbortSignal,
  ): Promise<LocalPerformanceSuggestionV2>;
}
