import type { AvatarEvent, RuntimeEffect } from '../../contracts/src/index.ts';
import type { TtsAdapter } from './types.ts';
import { TtsAdapterError } from './types.ts';

export class TtsRuntimeEffectHandler {
  private readonly controllers = new Map<number, Set<AbortController>>();
  private readonly adapter: TtsAdapter;

  constructor(adapter: TtsAdapter) { this.adapter = adapter; }

  handle(effect: RuntimeEffect, dispatch: (event: AvatarEvent) => void): boolean {
    if (effect.type === 'tts.synthesize') {
      const controller = new AbortController();
      const group = this.controllers.get(effect.generation) ?? new Set<AbortController>();
      group.add(controller);
      this.controllers.set(effect.generation, group);
      void this.adapter.synthesize({ text: effect.segment.speechText, signal: controller.signal })
        .then(audio => dispatch({ type: 'tts.segment-ready', generation: effect.generation, segmentId: effect.segment.id, sequence: effect.segment.sequence, audio }))
        .catch(cause => {
          const error = normalizeError(cause);
          dispatch({ type: 'tts.segment-failed', generation: effect.generation, segmentId: effect.segment.id, sequence: effect.segment.sequence,
            error: { code: error.code, message: error.message, recoverable: error.recoverable } });
        })
        .finally(() => {
          group.delete(controller);
          if (!group.size) this.controllers.delete(effect.generation);
        });
      return true;
    }
    if (effect.type === 'tts.cancel') {
      for (const controller of this.controllers.get(effect.generation) ?? []) controller.abort();
      this.controllers.delete(effect.generation);
      return true;
    }
    return false;
  }
}

function normalizeError(cause: unknown): TtsAdapterError {
  return cause instanceof TtsAdapterError
    ? cause
    : new TtsAdapterError('tts-adapter-failure', cause instanceof Error ? cause.message : String(cause));
}
