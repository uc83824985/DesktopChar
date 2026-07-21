import type {
  AmplitudeSample,
  AudioSource,
  AvatarEvent,
  AvatarSnapshot,
  GazeProfile,
  ParameterValue,
  PerformancePlan,
  PerformanceSegment,
  RuntimeEffect,
} from '../../contracts/src/index.ts';
import type { AvatarPlanner, RuntimePolicy } from './planner.ts';
import type { ParameterLayers } from './mixer.ts';
import { ParameterMixer } from './mixer.ts';
import { createInitialSnapshot, reduceAvatarSnapshot } from './reducer.ts';
import { PerformanceTimeline } from './timeline.ts';
import { DEFAULT_GAZE_PROFILE, mapGazeTarget, validateGazeProfile } from './gaze-profile.ts';

export interface RuntimeEffectExecutor {
  execute(effect: RuntimeEffect, dispatch: (event: AvatarEvent) => void): void | Promise<void>;
}

export interface AvatarRuntimeOptions {
  planner: AvatarPlanner;
  mixer: ParameterMixer;
  effects: RuntimeEffectExecutor;
  policy?: RuntimePolicy;
  gazeProfile?: GazeProfile;
}

export class AvatarRuntime {
  private snapshot: AvatarSnapshot = createInitialSnapshot();
  private readonly listeners = new Set<(snapshot: AvatarSnapshot) => void>();
  private plan: PerformancePlan | null = null;
  private nextSegmentIndex = 0;
  private readonly readyAudio = new Map<number, AudioSource>();
  private readonly failedSequences = new Set<number>();
  private timeline: PerformanceTimeline | null = null;
  private currentSource: AudioSource | null = null;
  private disposed = false;
  private layers: ParameterLayers = emptyLayers();
  private readonly options: AvatarRuntimeOptions;
  private readonly gazeProfile: GazeProfile;

  constructor(options: AvatarRuntimeOptions) {
    this.options = options;
    this.gazeProfile = options.gazeProfile ?? DEFAULT_GAZE_PROFILE;
    validateGazeProfile(this.gazeProfile);
  }

  getSnapshot(): AvatarSnapshot {
    return this.snapshot;
  }

  getActiveSegment(): Readonly<PerformanceSegment> | null {
    const segment = this.snapshot.segmentId ? this.segmentById(this.snapshot.segmentId) : undefined;
    return segment ? structuredClone(segment) : null;
  }

  subscribe(listener: (snapshot: AvatarSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  dispatch(event: AvatarEvent): void {
    if (this.disposed) return;

    let acceptedEvent = event;
    if (event.type === 'plan.submitted') {
      if (this.plan || this.snapshot.state !== 'idle') {
        throw new Error('A performance plan is already active');
      }
      const capabilities = this.snapshot.capabilities;
      if (!capabilities) {
        throw new Error('Renderer capabilities must be ready before submitting a plan');
      }
      const normalized = this.options.planner.normalize(event.plan, capabilities, this.options.policy);
      this.plan = normalized;
      this.nextSegmentIndex = 0;
      this.readyAudio.clear();
      this.failedSequences.clear();
      this.timeline = null;
      this.currentSource = null;
      this.layers = performanceLayersWithGaze(this.layers.gaze);
      acceptedEvent = { type: 'plan.submitted', plan: normalized };
    }

    if ('generation' in acceptedEvent && acceptedEvent.generation !== this.snapshot.generation) {
      return;
    }

    if (acceptedEvent.type.startsWith('playback.') && 'segmentId' in acceptedEvent) {
      if (acceptedEvent.segmentId !== this.snapshot.segmentId) return;
    }

    if (acceptedEvent.type === 'tts.segment-ready') {
      const segment = this.plan?.segments.find(candidate => (
        candidate.id === acceptedEvent.segmentId && candidate.sequence === acceptedEvent.sequence
      ));
      if (!segment) return;
      this.readyAudio.set(acceptedEvent.sequence, acceptedEvent.audio);
    }
    else if (acceptedEvent.type === 'tts.segment-failed') {
      const segment = this.plan?.segments.find(candidate => (
        candidate.id === acceptedEvent.segmentId && candidate.sequence === acceptedEvent.sequence
      ));
      if (!segment) return;
      this.failedSequences.add(acceptedEvent.sequence);
    }
    else if (acceptedEvent.type === 'playback.started') {
      const segment = this.segmentById(acceptedEvent.segmentId);
      if (segment) {
        this.timeline = new PerformanceTimeline(segment);
        this.applyTimeline(acceptedEvent.positionMs);
      }
    }
    else if (acceptedEvent.type === 'playback.progress') {
      if (this.snapshot.playback.status === 'paused') return;
      this.applyTimeline(acceptedEvent.positionMs);
      if (this.currentSource?.delivery === 'artifact') this.applyMouth(acceptedEvent.positionMs);
    }
    else if (acceptedEvent.type === 'playback.level') {
      if (this.snapshot.playback.status === 'paused') return;
      this.applyMouthValue(acceptedEvent.value);
    }
    else if (acceptedEvent.type === 'playback.paused') {
      this.timeline?.pause();
    }
    else if (acceptedEvent.type === 'playback.resumed') {
      this.timeline?.resume();
    }
    else if (acceptedEvent.type === 'playback.completed') {
      this.timeline?.cancel();
      this.timeline = null;
      this.currentSource = null;
      this.layers.mouth = neutralMouthLayer();
      this.emitFrame();
      this.nextSegmentIndex++;
    }
    else if (acceptedEvent.type === 'playback.failed') {
      this.timeline?.cancel();
      this.timeline = null;
      this.currentSource = null;
      this.layers.mouth = neutralMouthLayer();
      this.emitFrame();
      this.nextSegmentIndex++;
    }
    else if (acceptedEvent.type === 'user.interrupt-requested') {
      this.timeline?.cancel();
      this.timeline = null;
      this.currentSource = null;
      this.plan = null;
      this.readyAudio.clear();
      this.failedSequences.clear();
      this.layers = performanceLayersWithGaze(this.layers.gaze);
      this.emitFrame();
    }
    else if (
      acceptedEvent.type === 'user.look-target-changed'
      && this.snapshot.gaze.active
      && this.snapshot.capabilities?.supportsGaze
    ) {
      this.layers.gaze = gazeLayer(acceptedEvent.x, acceptedEvent.y, this.gazeProfile);
      this.emitFrame();
    }
    else if (acceptedEvent.type === 'user.gaze-follow-enabled' && this.snapshot.capabilities?.supportsGaze) {
      this.layers.gaze = gazeLayer(this.snapshot.gaze.x, this.snapshot.gaze.y, this.gazeProfile);
      this.emitFrame();
    }
    else if (acceptedEvent.type === 'user.gaze-follow-disabled') {
      // Runtime owns the rendered parameter frame. Removing the gaze layer would
      // leave the last authored eye/head values in Cubism until another motion
      // happened to overwrite them, so disabling gaze must author neutral values.
      this.layers.gaze = gazeLayer(0, 0, this.gazeProfile);
      this.emitFrame();
    }
    else if (acceptedEvent.type === 'runtime.plan-completed') {
      this.layers = performanceLayersWithGaze(this.layers.gaze);
      this.emitFrame();
    }

    const transition = reduceAvatarSnapshot(this.snapshot, acceptedEvent);
    this.snapshot = transition.snapshot;
    this.notify();
    this.executeAll(transition.effects);

    if (acceptedEvent.type === 'renderer.ready' && this.snapshot.gaze.active) {
      this.layers.gaze = gazeLayer(this.snapshot.gaze.x, this.snapshot.gaze.y, this.gazeProfile);
      this.emitFrame();
    }

    if (
      acceptedEvent.type === 'plan.submitted'
      || acceptedEvent.type === 'tts.segment-ready'
      || acceptedEvent.type === 'tts.segment-failed'
      || acceptedEvent.type === 'playback.completed'
      || acceptedEvent.type === 'playback.failed'
    ) {
      this.playNextReadySegment();
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.dispatch({ type: 'user.interrupt-requested' });
    this.disposed = true;
    this.listeners.clear();
  }

  private playNextReadySegment(): void {
    if (
      !this.plan
      || this.snapshot.playback.status === 'buffering'
      || this.snapshot.playback.status === 'playing'
      || this.snapshot.playback.status === 'paused'
    ) {
      return;
    }
    const segment = this.plan.segments[this.nextSegmentIndex];
    if (!segment) {
      this.dispatch({
        type: 'runtime.plan-completed',
        generation: this.snapshot.generation,
        planId: this.plan.id,
      });
      this.plan = null;
      return;
    }
    if (this.failedSequences.has(segment.sequence)) {
      this.failedSequences.delete(segment.sequence);
      this.nextSegmentIndex++;
      this.playNextReadySegment();
      return;
    }
    const audio = this.readyAudio.get(segment.sequence);
    if (!audio) return;
    this.readyAudio.delete(segment.sequence);
    this.currentSource = audio;
    this.dispatch({
      type: 'runtime.segment-selected',
      generation: this.snapshot.generation,
      segmentId: segment.id,
      sequence: segment.sequence,
    });
    this.execute({
      type: 'audio.play',
      generation: this.snapshot.generation,
      segmentId: segment.id,
      source: audio,
    });
  }

  private applyTimeline(positionMs: number): void {
    for (const cue of this.timeline?.advance(positionMs) ?? []) {
      if (cue.type === 'emotion') {
        this.layers.expression = emotionLayer(cue.payload.emotion, cue.payload.intensity);
        this.dispatch({
          type: 'timeline.emotion-cue',
          generation: this.snapshot.generation,
          cue: cue.payload,
        });
      }
      else {
        this.dispatch({
          type: 'timeline.action-cue',
          generation: this.snapshot.generation,
          cue: cue.payload,
        });
      }
    }
    this.emitFrame();
  }

  private applyMouth(positionMs: number): void {
    const mouthOpen = sampleAmplitude(this.currentSource?.amplitude, positionMs);
    this.applyMouthValue(mouthOpen);
  }

  private applyMouthValue(value: number): void {
    this.layers.mouth = { ParamMouthOpenY: { value: Math.max(0, Math.min(1, value)) } };
    this.emitFrame();
  }

  private emitFrame(): void {
    const capabilities = this.snapshot.capabilities;
    if (!capabilities) return;
    const frame = this.options.mixer.mix(this.layers, capabilities);
    this.execute({ type: 'renderer.apply-frame', frame });
  }

  private segmentById(segmentId: string): PerformanceSegment | undefined {
    return this.plan?.segments.find(segment => segment.id === segmentId);
  }

  private executeAll(effects: RuntimeEffect[]): void {
    for (const effect of effects) this.execute(effect);
  }

  private execute(effect: RuntimeEffect): void {
    try {
      const result = this.options.effects.execute(effect, event => this.dispatch(event));
      if (result instanceof Promise) {
        void result.catch(error => this.handleEffectError(effect, error));
      }
    }
    catch (error) {
      this.handleEffectError(effect, error);
    }
  }

  private handleEffectError(effect: RuntimeEffect, cause: unknown): void {
    const error = {
      code: 'effect-failed',
      message: cause instanceof Error ? cause.message : String(cause),
      recoverable: true,
    };
    switch (effect.type) {
      case 'tts.synthesize':
        this.dispatch({
          type: 'tts.segment-failed',
          generation: effect.generation,
          segmentId: effect.segment.id,
          sequence: effect.segment.sequence,
          error,
        });
        break;
      case 'renderer.play-motion':
        this.dispatch({
          type: 'renderer.motion-failed',
          generation: effect.generation,
          actionId: effect.command.actionId,
          error,
        });
        break;
      case 'renderer.apply-frame':
        this.dispatch({ type: 'renderer.failed', error });
        break;
      case 'audio.play':
        this.dispatch({
          type: 'playback.failed',
          generation: effect.generation,
          segmentId: effect.segmentId,
          error,
        });
        break;
      case 'audio.pause':
      case 'audio.resume':
      case 'audio.stop':
      case 'tts.cancel':
        this.dispatch({ type: 'runtime.effect-failed', generation: effect.generation, error });
        break;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

function emptyLayers(): ParameterLayers {
  return performanceLayersWithGaze({});
}

function performanceLayersWithGaze(gaze: Record<string, ParameterValue>): ParameterLayers {
  return {
    base: {},
    gaze: { ...gaze },
    expression: { ParamMouthForm: { value: 0, weight: 1, blend: 'overwrite' } },
    gesture: {},
    mouth: neutralMouthLayer(),
  };
}

function neutralMouthLayer(): Record<string, ParameterValue> {
  return { ParamMouthOpenY: { value: 0, blend: 'overwrite' } };
}

function gazeLayer(x: number, y: number, profile: GazeProfile): Record<string, ParameterValue> {
  return Object.fromEntries(Object.entries(mapGazeTarget(x, y, profile)).map(([parameter, value]) => (
    [parameter, { value, blend: 'overwrite' as const }]
  )));
}

function emotionLayer(emotion: string, intensity: number): Record<string, ParameterValue> {
  if (emotion === 'happy') {
    return { ParamMouthForm: { value: 1, weight: intensity, blend: 'lerp' } };
  }
  return { ParamMouthForm: { value: 0, weight: 1, blend: 'overwrite' } };
}

function sampleAmplitude(samples: AmplitudeSample[] | undefined, positionMs: number): number {
  if (!samples?.length) return 0.35;
  let selected = samples[0]!.value;
  for (const sample of samples) {
    if (sample.atMs > positionMs) break;
    selected = sample.value;
  }
  return Math.max(0, Math.min(1, selected));
}
