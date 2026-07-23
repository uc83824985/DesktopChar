import {
  PERFORMANCE_PLANNING_CONTRACT_VERSION,
  type LocalPerformanceSuggestion,
  type PerformanceInferenceCapabilities,
  type PerformancePlanningRequest,
} from '../../contracts/src/index.ts';
import type { PerformanceInferencePort } from './port.ts';

export class NoopPerformanceInference implements PerformanceInferencePort {
  describe(): PerformanceInferenceCapabilities {
    return {
      structuredOutput: 'json-object',
      thinkingControl: 'unsupported',
      streaming: false,
    };
  }

  async plan(
    request: PerformancePlanningRequest,
    signal: AbortSignal,
  ): Promise<LocalPerformanceSuggestion> {
    signal.throwIfAborted();
    return {
      contractVersion: PERFORMANCE_PLANNING_CONTRACT_VERSION,
      requestId: request.requestId,
      segmentId: request.segmentId,
      segmentRevision: request.segmentRevision,
      source: 'rules',
      provider: 'disabled',
      actions: [],
    };
  }
}
