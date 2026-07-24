import type { AvatarEvent, RuntimeEffect } from '../../contracts/src/index.ts';
import { PerformanceInferenceError } from './port.ts';
import type { PerformanceInferencePortV2 } from './v2-port.ts';

export class PerformanceRuntimeEffectHandlerV2 {
  private readonly pending = new Map<number, Set<AbortController>>();
  private readonly port: PerformanceInferencePortV2;

  constructor(port: PerformanceInferencePortV2) {
    this.port = port;
  }

  handle(effect: RuntimeEffect, dispatch: (event: AvatarEvent) => void): boolean {
    if (effect.type === 'performance.infer-v2') {
      const controller = new AbortController();
      const group = this.pending.get(effect.generation) ?? new Set<AbortController>();
      group.add(controller);
      this.pending.set(effect.generation, group);
      void this.port.plan(effect.request, controller.signal)
        .then(suggestion => dispatch({
          type: 'performance.suggestion-v2-ready',
          generation: effect.generation,
          planId: effect.request.planId,
          suggestion,
        }))
        .catch(cause => {
          if (controller.signal.aborted) return;
          const error = normalizeError(cause);
          dispatch({
            type: 'performance.suggestion-v2-failed',
            generation: effect.generation,
            planId: effect.request.planId,
            requestId: effect.request.requestId,
            segmentId: effect.request.segmentId,
            segmentRevision: effect.request.segmentRevision,
            catalogRevision: effect.request.catalogRevision,
            error: { code: error.code, message: error.message, recoverable: error.recoverable },
          });
        })
        .finally(() => {
          group.delete(controller);
          if (!group.size) this.pending.delete(effect.generation);
        });
      return true;
    }
    if (effect.type === 'performance.cancel-v2') {
      for (const controller of this.pending.get(effect.generation) ?? []) controller.abort();
      this.pending.delete(effect.generation);
      return true;
    }
    return false;
  }

  cancelAll(): void {
    for (const group of this.pending.values()) {
      for (const controller of group) controller.abort();
    }
    this.pending.clear();
  }
}

function normalizeError(cause: unknown): PerformanceInferenceError {
  return cause instanceof PerformanceInferenceError
    ? cause
    : new PerformanceInferenceError(
        'performance-inference-failure',
        cause instanceof Error ? cause.message : String(cause),
        { cause },
      );
}
