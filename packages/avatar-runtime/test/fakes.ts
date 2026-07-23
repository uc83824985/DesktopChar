import type {
  AudioSource,
  AvatarEvent,
  RuntimeEffect,
} from '../../contracts/src/index.ts';
import type { RuntimeEffectExecutor } from '../src/runtime.ts';

interface PendingTts {
  effect: Extract<RuntimeEffect, { type: 'tts.synthesize' }>;
  dispatch: (event: AvatarEvent) => void;
}

interface PendingBubbleDismissal {
  effect: Extract<RuntimeEffect, { type: 'speech-bubble.schedule-dismiss' }>;
  dispatch: (event: AvatarEvent) => void;
}

interface PendingPerformance {
  effect: Extract<RuntimeEffect, { type: 'performance.infer' }>;
  dispatch: (event: AvatarEvent) => void;
}

export class ControlledEffects implements RuntimeEffectExecutor {
  readonly pendingTts = new Map<number, PendingTts>();
  readonly pendingPerformance = new Map<string, PendingPerformance>();
  readonly playedSegments: string[] = [];
  readonly frames: Array<Record<string, number>> = [];
  readonly motions: string[] = [];
  readonly expressions: Array<Extract<RuntimeEffect, { type: 'renderer.set-expression' }>['command']> = [];
  readonly cancelledGenerations: number[] = [];
  readonly cancelledPerformanceGenerations: number[] = [];
  readonly stoppedGenerations: number[] = [];
  readonly pendingBubbleDismissals = new Map<number, PendingBubbleDismissal>();
  readonly cancelledBubbleDismissals: number[] = [];
  private current: {
    generation: number;
    segmentId: string;
    dispatch: (event: AvatarEvent) => void;
  } | null = null;

  execute(effect: RuntimeEffect, dispatch: (event: AvatarEvent) => void): void {
    switch (effect.type) {
      case 'tts.synthesize':
        this.pendingTts.set(effect.segment.sequence, { effect, dispatch });
        break;
      case 'tts.cancel':
        this.cancelledGenerations.push(effect.generation);
        this.pendingTts.clear();
        break;
      case 'performance.infer':
        this.pendingPerformance.set(effect.request.segmentId, { effect, dispatch });
        break;
      case 'performance.cancel':
        this.cancelledPerformanceGenerations.push(effect.generation);
        this.pendingPerformance.clear();
        break;
      case 'audio.play':
        this.playedSegments.push(effect.segmentId);
        this.current = { generation: effect.generation, segmentId: effect.segmentId, dispatch };
        dispatch({
          type: 'playback.started',
          generation: effect.generation,
          segmentId: effect.segmentId,
          positionMs: 0,
        });
        break;
      case 'audio.pause':
        if (this.current) {
          dispatch({
            type: 'playback.paused',
            generation: effect.generation,
            segmentId: this.current.segmentId,
            positionMs: 0,
          });
        }
        break;
      case 'audio.resume':
        if (this.current) {
          dispatch({
            type: 'playback.resumed',
            generation: effect.generation,
            segmentId: this.current.segmentId,
            positionMs: 0,
          });
        }
        break;
      case 'audio.stop':
        this.stoppedGenerations.push(effect.generation);
        this.current = null;
        break;
      case 'speech-bubble.schedule-dismiss':
        this.pendingBubbleDismissals.set(effect.presentationId, { effect, dispatch });
        break;
      case 'speech-bubble.cancel-dismiss':
        this.pendingBubbleDismissals.delete(effect.presentationId);
        this.cancelledBubbleDismissals.push(effect.presentationId);
        break;
      case 'renderer.apply-frame':
        this.frames.push(effect.frame);
        break;
      case 'renderer.set-expression':
        this.expressions.push(structuredClone(effect.command));
        break;
      case 'renderer.play-motion':
        this.motions.push(effect.command.actionId);
        break;
    }
  }

  resolveTts(sequence: number, audio?: AudioSource): void {
    const pending = this.pendingTts.get(sequence);
    if (!pending) throw new Error(`No pending TTS for sequence ${sequence}`);
    this.pendingTts.delete(sequence);
    pending.dispatch({
      type: 'tts.segment-ready',
      generation: pending.effect.generation,
      segmentId: pending.effect.segment.id,
      sequence,
      audio: audio ?? {
        delivery: 'artifact',
        requestId: `fake-${sequence}`,
        uri: `memory://${sequence}`,
        mimeType: 'audio/wav',
      },
    });
  }

  failTts(sequence: number): void {
    const pending = this.pendingTts.get(sequence);
    if (!pending) throw new Error(`No pending TTS for sequence ${sequence}`);
    this.pendingTts.delete(sequence);
    pending.dispatch({
      type: 'tts.segment-failed',
      generation: pending.effect.generation,
      segmentId: pending.effect.segment.id,
      sequence,
      error: { code: 'fake-tts-failed', message: 'fake failure', recoverable: true },
    });
  }

  resolvePerformance(
    segmentId: string,
    suggestion: Partial<Extract<AvatarEvent, { type: 'performance.suggestion-ready' }>['suggestion']> = {},
  ): void {
    const pending = this.pendingPerformance.get(segmentId);
    if (!pending) throw new Error(`No pending performance inference for ${segmentId}`);
    this.pendingPerformance.delete(segmentId);
    pending.dispatch({
      type: 'performance.suggestion-ready',
      generation: pending.effect.generation,
      planId: pending.effect.request.planId,
      suggestion: {
        contractVersion: pending.effect.request.contractVersion,
        requestId: pending.effect.request.requestId,
        segmentId,
        segmentRevision: pending.effect.request.segmentRevision,
        source: 'model',
        provider: 'controlled-test',
        actions: [],
        ...suggestion,
      },
    });
  }

  progress(positionMs: number): void {
    if (!this.current) throw new Error('No current playback');
    this.current.dispatch({
      type: 'playback.progress',
      generation: this.current.generation,
      segmentId: this.current.segmentId,
      positionMs,
    });
  }

  complete(positionMs = 1000): void {
    if (!this.current) throw new Error('No current playback');
    const current = this.current;
    this.current = null;
    current.dispatch({
      type: 'playback.completed',
      generation: current.generation,
      segmentId: current.segmentId,
      positionMs,
    });
  }

  dismissBubble(presentationId: number): void {
    const pending = this.pendingBubbleDismissals.get(presentationId);
    if (!pending) throw new Error(`No pending speech bubble dismissal for ${presentationId}`);
    this.pendingBubbleDismissals.delete(presentationId);
    pending.dispatch({
      type: 'runtime.speech-bubble-dismissed',
      generation: pending.effect.generation,
      presentationId,
    });
  }
}
