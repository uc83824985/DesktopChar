import type { AvatarEvent, RuntimeEffect } from '../../contracts/src/index.ts';
import type { TtsAdapter, TtsDeliveryPreference, TtsSynthesisRequest } from './types.ts';
import { TtsAdapterError } from './types.ts';

interface PendingPreparation {
  requestId: string;
  controller: AbortController;
}

export interface TtsRuntimeEffectHandlerOptions {
  delivery?: TtsDeliveryPreference;
  voice?: string;
  language?: string;
  instruction?: string;
  rate?: number;
  format?: TtsSynthesisRequest['format'];
}

export class TtsRuntimeEffectHandler {
  private readonly pending = new Map<number, Set<PendingPreparation>>();
  private readonly requestIds = new Map<number, Set<string>>();
  private readonly adapter: TtsAdapter;
  private readonly requestDefaults: TtsRuntimeEffectHandlerOptions;

  constructor(adapter: TtsAdapter, options: TtsRuntimeEffectHandlerOptions = {}) {
    this.adapter = adapter;
    this.requestDefaults = options;
  }

  handle(effect: RuntimeEffect, dispatch: (event: AvatarEvent) => void): boolean {
    if (effect.type === 'tts.synthesize') {
      const requestId = `g${effect.generation}:${effect.segment.id}`;
      for (const generation of this.requestIds.keys()) {
        if (generation < effect.generation) this.requestIds.delete(generation);
      }
      const requestIds = this.requestIds.get(effect.generation) ?? new Set<string>();
      requestIds.add(requestId);
      this.requestIds.set(effect.generation, requestIds);
      const preparation = { requestId, controller: new AbortController() };
      const group = this.pending.get(effect.generation) ?? new Set<PendingPreparation>();
      group.add(preparation);
      this.pending.set(effect.generation, group);
      void this.adapter.prepare({
        requestId,
        text: effect.segment.speechText,
        delivery: this.requestDefaults.delivery ?? 'stream-required',
        signal: preparation.controller.signal,
        ...(this.requestDefaults.voice !== undefined ? { voice: this.requestDefaults.voice } : {}),
        ...(this.requestDefaults.language !== undefined ? { language: this.requestDefaults.language } : {}),
        ...(this.requestDefaults.instruction !== undefined ? { instruction: this.requestDefaults.instruction } : {}),
        ...(this.requestDefaults.rate !== undefined ? { rate: this.requestDefaults.rate } : {}),
        ...(this.requestDefaults.format !== undefined ? { format: this.requestDefaults.format } : {}),
      })
        .then(audio => dispatch({ type: 'tts.segment-ready', generation: effect.generation, segmentId: effect.segment.id, sequence: effect.segment.sequence, audio }))
        .catch(cause => {
          requestIds.delete(requestId);
          if (!requestIds.size) this.requestIds.delete(effect.generation);
          const error = normalizeError(cause);
          dispatch({ type: 'tts.segment-failed', generation: effect.generation, segmentId: effect.segment.id, sequence: effect.segment.sequence,
            error: { code: error.code, message: error.message, recoverable: error.recoverable } });
        })
        .finally(() => {
          group.delete(preparation);
          if (!group.size) this.pending.delete(effect.generation);
        });
      return true;
    }
    if (effect.type === 'tts.cancel') {
      for (const preparation of this.pending.get(effect.generation) ?? []) {
        preparation.controller.abort();
      }
      for (const requestId of this.requestIds.get(effect.generation) ?? []) {
        void this.adapter.cancel(requestId).catch(() => undefined);
      }
      this.pending.delete(effect.generation);
      this.requestIds.delete(effect.generation);
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
