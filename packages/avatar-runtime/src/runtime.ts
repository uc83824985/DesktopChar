import {
  DEFAULT_LIP_SYNC_PROFILE,
  PERFORMANCE_PLANNING_CONTRACT_VERSION,
  PERFORMANCE_PLANNING_V2_CONTRACT_VERSION,
  type AmplitudeSample,
  type AudioSource,
  type AvatarEvent,
  type AvatarSnapshot,
  type CharacterActionCatalog,
  type CharacterExpressionCatalog,
  type Emotion,
  type EmotionBindings,
  type ExpressionSelectionHistoryEntry,
  type GazeProfile,
  type LipSyncProfile,
  type ParameterValue,
  type PerformanceActionDescriptor,
  type PerformancePlan,
  type PerformanceTextAnchor,
  type PersonaPerformanceProjection,
  type ScenePerformanceProjection,
  type SceneActionContext,
  type PerformanceSegment,
  type RuntimeEffect,
  type SpeechBubbleState,
} from '../../contracts/src/index.ts';
import { DEFAULT_RUNTIME_POLICY, type AvatarPlanner, type RuntimePolicy } from './planner.ts';
import {
  applyPerformanceSuggestion,
  applyPerformanceSuggestionV2,
  type PerformanceSuggestionSlots,
} from './performance-suggestion.ts';
import {
  performanceRequestKey,
  splitPerformanceClauses,
} from './performance-clauses.ts';
import { resolveExpression } from './expression-resolver.ts';
import type { ParameterLayers } from './mixer.ts';
import { ParameterMixer } from './mixer.ts';
import { createInitialSnapshot, reduceAvatarSnapshot } from './reducer.ts';
import { ActionRuntime, type ActionRuntimeTransition } from './action-runtime.ts';
import { PerformanceTimeline } from './timeline.ts';
import { DEFAULT_GAZE_PROFILE } from './gaze-profile.ts';
import { GazeInterpolator } from './gaze-interpolator.ts';
import { LipSyncEnvelope, validateLipSyncProfile } from './lip-sync-envelope.ts';
import {
  DEFAULT_SPEECH_BUBBLE_DISMISS_DELAY_MS,
  estimateTextFallbackDurationMs,
} from './speech-bubble.ts';

export interface RuntimeEffectExecutor {
  execute(effect: RuntimeEffect, dispatch: (event: AvatarEvent) => void): void | Promise<void>;
}

export type RuntimePerformanceLogger = (
  event: string,
  data: Record<string, unknown>,
) => void;

export interface AvatarRuntimeOptions {
  planner: AvatarPlanner;
  mixer: ParameterMixer;
  effects: RuntimeEffectExecutor;
  policy?: RuntimePolicy;
  performancePlanning?: PerformancePlanningOptions;
  emotionBindings?: EmotionBindings;
  expressionCatalog?: CharacterExpressionCatalog;
  actionCatalog?: CharacterActionCatalog;
  sceneActionContext?: SceneActionContext;
  expressionRandomSeed?: number;
  actionRandom?: () => number;
  performanceLogger?: RuntimePerformanceLogger;
  clock?: () => number;
  gazeProfile?: GazeProfile;
  lipSyncProfile?: LipSyncProfile;
}

export interface PerformancePlanningOptions {
  persona: PersonaPerformanceProjection;
  scene: ScenePerformanceProjection;
  actions?: PerformanceActionDescriptor[];
}

export class AvatarRuntime {
  private snapshot: AvatarSnapshot = createInitialSnapshot();
  private readonly listeners = new Set<(snapshot: AvatarSnapshot) => void>();
  private plan: PerformancePlan | null = null;
  private nextSegmentIndex = 0;
  private readonly readyAudio = new Map<number, AudioSource>();
  private readonly failedSequences = new Set<number>();
  private readonly performanceRequests = new Map<string, {
    requestId: string;
    segmentId: string;
    revision: number;
    catalogRevision?: number;
    textAnchor?: PerformanceTextAnchor;
  }>();
  private readonly performanceSlots = new Map<string, PerformanceSuggestionSlots>();
  private readonly expressionHistory: ExpressionSelectionHistoryEntry[] = [];
  private performanceRequestSequence = 0;
  private timeline: PerformanceTimeline | null = null;
  private currentSource: AudioSource | null = null;
  private textFallback: { presentationId: number; segmentId: string; sequence: number } | null = null;
  private disposed = false;
  private layers: ParameterLayers = emptyLayers();
  private readonly options: AvatarRuntimeOptions;
  private readonly policy: RuntimePolicy;
  private readonly gazeInterpolator: GazeInterpolator;
  private readonly lipSyncProfile: LipSyncProfile;
  private readonly lipSyncEnvelope: LipSyncEnvelope;
  private readonly expressionRandomSeed: number;
  private readonly clock: () => number;
  private readonly actionRuntime: ActionRuntime;
  private readonly actionRandom: () => number;

  constructor(options: AvatarRuntimeOptions) {
    this.options = options;
    this.policy = options.policy ?? DEFAULT_RUNTIME_POLICY;
    this.gazeInterpolator = new GazeInterpolator(options.gazeProfile ?? DEFAULT_GAZE_PROFILE);
    this.lipSyncProfile = options.lipSyncProfile ?? { ...DEFAULT_LIP_SYNC_PROFILE };
    validateLipSyncProfile(this.lipSyncProfile);
    this.lipSyncEnvelope = new LipSyncEnvelope(this.lipSyncProfile);
    this.expressionRandomSeed = options.expressionRandomSeed ?? 0x44534348;
    if (!Number.isInteger(this.expressionRandomSeed)) {
      throw new TypeError('expressionRandomSeed must be an integer');
    }
    this.clock = options.clock ?? (() => Date.now());
    this.actionRandom = options.actionRandom ?? Math.random;
    this.actionRuntime = new ActionRuntime(
      options.actionCatalog ?? legacyActionCatalog(),
      options.sceneActionContext ?? {
        generation: 0,
        revision: 0,
        sceneId: options.performancePlanning?.scene.id ?? null,
        tags: [...(options.performancePlanning?.scene.modeTags ?? [])],
        posture: 'standing',
        allowedActionTags: [],
        blockedActionTags: [],
        triggerChanceMultipliers: {},
      },
    );
    const catalog = options.expressionCatalog;
    if (catalog) {
      this.snapshot = {
        ...this.snapshot,
        expression: {
          currentKey: catalog.defaultExpressionKey,
          intensity: 0,
          catalogRevision: catalog.revision,
          startedAtMs: null,
          holdUntilMs: null,
        },
      };
    }
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
    if (event.type === 'renderer.frame-tick') {
      const frame = this.gazeInterpolator.advance(event.deltaMs);
      if (frame) {
        this.layers.gaze = gazeParameterLayer(frame);
        this.emitFrame();
      }
      return;
    }

    let acceptedEvent = event;
    let submittedPerformanceEffects: RuntimeEffect[] = [];
    let actionTransition: ActionRuntimeTransition | undefined;
    if (event.type === 'presentation.chat-bubble-requested') {
      if (this.snapshot.state !== 'idle') {
        throw new Error('A chat-bubble presentation can only start while the Runtime is idle');
      }
      const text = event.text.trim();
      if (!text) throw new Error('A chat-bubble presentation requires non-empty text');
      if (
        event.dismissDelayMs !== undefined
        && (!Number.isFinite(event.dismissDelayMs) || event.dismissDelayMs < 0)
      ) {
        throw new RangeError('Chat-bubble dismissDelayMs must be finite and non-negative');
      }
      acceptedEvent = { ...event, text };
    }
    if (event.type === 'plan.submitted') {
      if (this.plan || this.snapshot.state !== 'idle') {
        throw new Error('A performance plan is already active');
      }
      const capabilities = this.snapshot.capabilities;
      if (!capabilities) {
        throw new Error('Renderer capabilities must be ready before submitting a plan');
      }
      const normalized = this.options.planner.normalize(event.plan, capabilities, this.options.policy);
      this.validateExplicitExpressions(normalized);
      this.performanceSlots.clear();
      for (const original of event.plan.segments) {
        this.performanceSlots.set(original.id, {
          emotion: original.emotion === undefined,
          expression: (
            original.expression === undefined
            && !original.expressionCues?.length
            && original.emotion === undefined
          ),
          actions: original.actions === undefined,
        });
      }
      this.plan = normalized;
      this.nextSegmentIndex = 0;
      this.readyAudio.clear();
      this.failedSequences.clear();
      this.timeline = null;
      this.currentSource = null;
      this.textFallback = null;
      this.performanceRequests.clear();
      this.layers = performanceLayersWithGaze(this.layers.gaze);
      acceptedEvent = { type: 'plan.submitted', plan: normalized };
      submittedPerformanceEffects = this.createPerformanceEffects(normalized);
    }

    if ('generation' in acceptedEvent && acceptedEvent.generation !== this.snapshot.generation) {
      return;
    }

    const actionEnvironment = {
      generation: this.snapshot.generation,
      avatarState: this.snapshot.state,
      speechActive: this.snapshot.playback.status === 'playing'
        || this.snapshot.playback.status === 'buffering'
        || this.snapshot.playback.status === 'paused',
    };
    if (acceptedEvent.type === 'scene.action-context-updated') {
      actionTransition = this.actionRuntime.updateSceneContext(acceptedEvent.context);
    }
    else if (acceptedEvent.type === 'action.requested') {
      actionTransition = this.actionRuntime.request(acceptedEvent.intent, actionEnvironment);
    }
    else if (acceptedEvent.type === 'timeline.action-cue') {
      actionTransition = this.actionRuntime.request({
        requestId: acceptedEvent.cue.id,
        source: 'performance',
        trigger: 'performance.action',
        mode: 'required',
        occurredAtMs: this.clock(),
        selectionRandomValue: 0,
        chanceRandomValue: 0,
        requestedActionId: acceptedEvent.cue.action,
        ...(acceptedEvent.cue.priority === undefined ? {} : { priority: acceptedEvent.cue.priority }),
      }, actionEnvironment);
    }
    else if (acceptedEvent.type === 'runtime.plan-completed') {
      const occurredAtMs = this.clock();
      actionTransition = this.actionRuntime.request({
        requestId: `conversation-completed:${acceptedEvent.planId}:${occurredAtMs}`,
        source: 'scene',
        trigger: 'conversation.completed',
        mode: 'optional',
        occurredAtMs,
        selectionRandomValue: this.nextActionRandom(),
        chanceRandomValue: this.nextActionRandom(),
        semanticTags: ['ambient'],
      }, {
        ...actionEnvironment,
        avatarState: 'idle',
        speechActive: false,
      });
    }
    else if (acceptedEvent.type === 'renderer.motion-completed') {
      actionTransition = this.actionRuntime.complete(
        acceptedEvent.requestId,
        this.clock(),
        actionEnvironment,
      );
    }
    else if (
      acceptedEvent.type === 'renderer.motion-failed'
      || acceptedEvent.type === 'renderer.motion-interrupted'
    ) {
      actionTransition = this.actionRuntime.fail(
        acceptedEvent.requestId,
        this.clock(),
        actionEnvironment,
      );
    }
    else if (acceptedEvent.type === 'user.interrupt-requested') {
      actionTransition = this.actionRuntime.interrupt(this.snapshot.generation);
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
    else if (acceptedEvent.type === 'performance.suggestion-ready') {
      this.acceptPerformanceSuggestion(acceptedEvent);
    }
    else if (acceptedEvent.type === 'performance.suggestion-v2-ready') {
      this.acceptPerformanceSuggestionV2(acceptedEvent);
    }
    else if (acceptedEvent.type === 'performance.suggestion-failed') {
      const pending = this.performanceRequests.get(acceptedEvent.requestId);
      if (
        acceptedEvent.planId === this.plan?.id
        && pending?.segmentId === acceptedEvent.segmentId
        && pending?.revision === acceptedEvent.segmentRevision
      ) {
        this.performanceRequests.delete(acceptedEvent.requestId);
      }
    }
    else if (acceptedEvent.type === 'performance.suggestion-v2-failed') {
      const pending = this.performanceRequests.get(acceptedEvent.requestId);
      if (
        acceptedEvent.planId === this.plan?.id
        && pending?.segmentId === acceptedEvent.segmentId
        && pending?.revision === acceptedEvent.segmentRevision
        && pending?.catalogRevision === acceptedEvent.catalogRevision
      ) {
        this.performanceRequests.delete(acceptedEvent.requestId);
      }
    }
    else if (acceptedEvent.type === 'playback.started') {
      this.lipSyncEnvelope.reset(acceptedEvent.positionMs);
      const segment = this.segmentById(acceptedEvent.segmentId);
      if (segment) {
        this.timeline = new PerformanceTimeline(segment, {
          ...(this.currentSource?.durationMs !== undefined
            ? { durationMs: this.currentSource.durationMs }
            : {}),
          ...(this.currentSource?.fallbackCharactersPerSecond !== undefined
            ? {
                fallbackCharactersPerSecond:
                  this.currentSource.fallbackCharactersPerSecond,
              }
            : {}),
        });
        this.logPerformance('expression.timeline-started', {
          segmentId: segment.id,
          durationMs: this.currentSource?.durationMs ?? null,
          fallbackCharactersPerSecond:
            this.currentSource?.fallbackCharactersPerSecond ?? null,
        });
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
      this.applyMouthValue(acceptedEvent.value, acceptedEvent.positionMs);
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
      this.lipSyncEnvelope.reset(acceptedEvent.positionMs);
      this.layers.mouth = neutralMouthLayer();
      this.emitFrame();
      this.nextSegmentIndex++;
    }
    else if (acceptedEvent.type === 'playback.failed') {
      this.timeline?.cancel();
      this.timeline = null;
      this.currentSource = null;
      this.lipSyncEnvelope.reset();
      this.layers.mouth = neutralMouthLayer();
      this.emitFrame();
      this.nextSegmentIndex++;
    }
    else if (acceptedEvent.type === 'user.interrupt-requested') {
      this.timeline?.cancel();
      this.timeline = null;
      this.currentSource = null;
      this.plan = null;
      this.textFallback = null;
      this.readyAudio.clear();
      this.failedSequences.clear();
      this.performanceRequests.clear();
      this.performanceSlots.clear();
      this.lipSyncEnvelope.reset();
      this.layers = performanceLayersWithGaze(this.layers.gaze);
      this.emitFrame();
      this.resetBoundExpression();
    }
    else if (acceptedEvent.type === 'runtime.plan-completed') {
      this.performanceRequests.clear();
      this.performanceSlots.clear();
      this.layers = performanceLayersWithGaze(this.layers.gaze);
      this.emitFrame();
      this.resetBoundExpression();
    }

    const bubbleTransition = this.transitionSpeechBubble(acceptedEvent);
    const transition = reduceAvatarSnapshot(this.snapshot, acceptedEvent);
    this.snapshot = {
      ...transition.snapshot,
      speechBubble: bubbleTransition.state,
      gesture: actionTransition?.gesture ?? this.actionRuntime.getGesture(),
    };
    if (
      acceptedEvent.type === 'user.interrupt-requested'
      || acceptedEvent.type === 'runtime.plan-completed'
    ) {
      this.restoreDefaultExpressionSnapshot();
    }
    if (
      acceptedEvent.type === 'renderer.ready'
      || acceptedEvent.type === 'user.look-target-changed'
      || acceptedEvent.type === 'user.gaze-follow-enabled'
      || acceptedEvent.type === 'user.gaze-follow-disabled'
    ) {
      this.gazeInterpolator.setReference(this.snapshot.gaze.x, this.snapshot.gaze.y);
      this.gazeInterpolator.setActive(this.snapshot.gaze.active);
      if (acceptedEvent.type === 'renderer.ready') {
        const initialGazeFrame = this.gazeInterpolator.advance(0);
        if (initialGazeFrame) this.layers.gaze = gazeParameterLayer(initialGazeFrame);
      }
    }
    this.notify();
    this.executeAll(transition.effects);
    this.executeAll(actionTransition?.effects ?? []);
    this.executeAll(submittedPerformanceEffects);
    this.executeAll(bubbleTransition.effects);
    if (acceptedEvent.type === 'renderer.ready') this.emitFrame();

    if (
      acceptedEvent.type === 'runtime.speech-bubble-dismissed'
      && acceptedEvent.presentationId === this.textFallback?.presentationId
    ) {
      const completed = this.textFallback;
      this.textFallback = null;
      this.nextSegmentIndex++;
      this.dispatch({
        type: 'runtime.text-fallback-completed',
        generation: this.snapshot.generation,
        segmentId: completed.segmentId,
        sequence: completed.sequence,
      });
      return;
    }

    if (
      acceptedEvent.type === 'plan.submitted'
      || acceptedEvent.type === 'tts.segment-ready'
      || acceptedEvent.type === 'tts.segment-failed'
      || acceptedEvent.type === 'playback.completed'
      || acceptedEvent.type === 'playback.failed'
      || acceptedEvent.type === 'runtime.text-fallback-completed'
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
      || this.textFallback !== null
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
      const presentationId = this.snapshot.speechBubble.presentationId + 1;
      this.textFallback = { presentationId, segmentId: segment.id, sequence: segment.sequence };
      this.dispatch({
        type: 'runtime.text-fallback-selected',
        generation: this.snapshot.generation,
        segmentId: segment.id,
        sequence: segment.sequence,
        presentationId,
        durationMs: estimateTextFallbackDurationMs(segment.displayText),
      });
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
        this.applyBoundExpression(cue.payload.emotion, cue.payload.intensity);
      }
      else if (cue.type === 'expression') {
        const catalog = this.options.expressionCatalog;
        if (!catalog) continue;
        // Reapplying the same Cubism expression can visibly restart its fade.
        // The cue is already marked emitted by the Timeline, so identical
        // adjacent clause results become a stable hold instead of a flicker.
        if (this.snapshot.expression.currentKey === cue.payload.expressionKey) {
          this.logPerformance('expression.cue-held', {
            segmentId: this.timeline?.segmentId ?? null,
            expressionKey: cue.payload.expressionKey,
            plannedAtMs: cue.atMs,
            actualPositionMs: positionMs,
            timingBasis: cue.timingBasis,
            triggerText: cue.payload.triggerText ?? null,
            textAnchor: cue.payload.textAnchor ?? null,
          });
          continue;
        }
        this.logPerformance('expression.cue-fired', {
          segmentId: this.timeline?.segmentId ?? null,
          expressionKey: cue.payload.expressionKey,
          plannedAtMs: cue.atMs,
          actualPositionMs: positionMs,
          lagMs: Math.max(0, positionMs - cue.atMs),
          timingBasis: cue.timingBasis,
          triggerText: cue.payload.triggerText ?? null,
          textAnchor: cue.payload.textAnchor ?? null,
        });
        const startedAtMs = this.clock();
        this.dispatch({
          type: 'timeline.expression-cue',
          generation: this.snapshot.generation,
          catalogRevision: catalog.revision,
          startedAtMs,
          cue: cue.payload,
        });
        this.expressionHistory.push({
          expressionKey: cue.payload.expressionKey,
          selectedAtMs: startedAtMs,
        });
        if (this.expressionHistory.length > 32) this.expressionHistory.splice(0, 16);
        this.applyBoundExpressionKey(cue.payload.expressionKey, cue.payload.intensity);
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

  private createPerformanceEffects(plan: PerformancePlan): RuntimeEffect[] {
    const planning = this.options.performancePlanning;
    const capabilities = this.snapshot.capabilities;
    if (!planning || !capabilities) return [];
    const configuredActions = planning.actions ?? capabilities.actions.map(actionId => ({
      actionId,
      label: actionId,
      tags: [],
      allowedAnchors: ['segment-start'] as const,
    }));
    const actions = configuredActions.filter(descriptor => (
      capabilities.actions.includes(descriptor.actionId)
      && descriptor.allowedAnchors.length > 0
    ));
    if (this.options.expressionCatalog) {
      return this.createPerformanceEffectsV2(plan, actions);
    }
    return plan.segments.flatMap(segment => {
      const slots = this.performanceSlots.get(segment.id);
      const text = (segment.displayText || segment.speechText).trim();
      if (!slots || (!slots.emotion && !slots.actions) || !text) return [];
      const revision = 0;
      const requestId = `g${this.snapshot.generation}:q${++this.performanceRequestSequence}:${plan.id}:${segment.id}:r${revision}`;
      this.performanceRequests.set(requestId, { requestId, segmentId: segment.id, revision });
      return [{
        type: 'performance.infer' as const,
        generation: this.snapshot.generation,
        request: {
          contractVersion: PERFORMANCE_PLANNING_CONTRACT_VERSION,
          requestId,
          planId: plan.id,
          segmentId: segment.id,
          segmentRevision: revision,
          text,
          persona: structuredClone(planning.persona),
          scene: structuredClone(planning.scene),
          avatar: {
            state: 'thinking',
            currentEmotion: this.snapshot.emotion.current,
          },
          emotions: [...capabilities.emotions],
          actions: structuredClone(actions),
        },
      }];
    });
  }

  private createPerformanceEffectsV2(
    plan: PerformancePlan,
    actions: PerformanceActionDescriptor[],
  ): RuntimeEffect[] {
    const planning = this.options.performancePlanning;
    const catalog = this.options.expressionCatalog;
    if (!planning || !catalog) return [];
    return plan.segments.flatMap(segment => {
      const slots = this.performanceSlots.get(segment.id);
      const text = segment.speechText;
      if (!slots || (!slots.expression && !slots.actions) || !text.trim()) return [];
      const revision = 0;
      const clauses = slots.expression
        ? splitPerformanceClauses(text)
        : splitPerformanceClauses(text, 1);
      return clauses.map((clause, index): RuntimeEffect => {
        const requestId = `g${this.snapshot.generation}:q${++this.performanceRequestSequence}:${plan.id}:${segment.id}:r${revision}:c${catalog.revision}:k${clause.anchor.clauseIndex}`;
        this.performanceRequests.set(requestId, {
          requestId,
          segmentId: segment.id,
          revision,
          catalogRevision: catalog.revision,
          textAnchor: structuredClone(clause.anchor),
        });
        this.logPerformance('expression.clause-requested', {
          requestId,
          planId: plan.id,
          segmentId: segment.id,
          text: clause.text,
          textAnchor: clause.anchor,
          actionSelectionEnabled: index === 0 && slots.actions,
        });
        return {
          type: 'performance.infer-v2',
          generation: this.snapshot.generation,
          request: {
            contractVersion: PERFORMANCE_PLANNING_V2_CONTRACT_VERSION,
            requestId,
            planId: plan.id,
            segmentId: segment.id,
            segmentRevision: revision,
            catalogRevision: catalog.revision,
            defaultExpressionKey: catalog.defaultExpressionKey,
            text: clause.text,
            textAnchor: structuredClone(clause.anchor),
            persona: structuredClone(planning.persona),
            scene: structuredClone(planning.scene),
            avatar: {
              state: 'thinking',
              currentExpressionKey: this.snapshot.expression.currentKey ?? catalog.defaultExpressionKey,
              coarseEmotion: this.snapshot.emotion.current,
            },
            expressions: structuredClone(catalog.descriptors),
            actions: index === 0 && slots.actions ? structuredClone(actions) : [],
          },
        };
      });
    });
  }

  private acceptPerformanceSuggestion(
    event: Extract<AvatarEvent, { type: 'performance.suggestion-ready' }>,
  ): void {
    if (!this.plan || event.planId !== this.plan.id) return;
    const suggestion = event.suggestion;
    const pending = this.performanceRequests.get(suggestion.requestId);
    if (
      !pending
      || pending.segmentId !== suggestion.segmentId
      || pending.revision !== suggestion.segmentRevision
    ) {
      return;
    }
    this.performanceRequests.delete(suggestion.requestId);
    if (
      suggestion.contractVersion !== PERFORMANCE_PLANNING_CONTRACT_VERSION
      || !Array.isArray(suggestion.actions)
    ) {
      return;
    }
    const segmentIndex = this.plan.segments.findIndex(segment => segment.id === suggestion.segmentId);
    if (segmentIndex < this.nextSegmentIndex || segmentIndex < 0) return;
    const segment = this.plan.segments[segmentIndex]!;
    const slots = this.performanceSlots.get(segment.id);
    const capabilities = this.snapshot.capabilities;
    if (!slots || !capabilities) return;
    const updated = applyPerformanceSuggestion(segment, suggestion, slots, capabilities, this.policy);
    this.plan.segments[segmentIndex] = updated;
    if (this.timeline?.segmentId === updated.id) {
      this.timeline.update(updated);
      this.applyTimeline(this.snapshot.playback.positionMs);
    }
  }

  private acceptPerformanceSuggestionV2(
    event: Extract<AvatarEvent, { type: 'performance.suggestion-v2-ready' }>,
  ): void {
    const catalog = this.options.expressionCatalog;
    if (!catalog || !this.plan || event.planId !== this.plan.id) return;
    const suggestion = event.suggestion;
    const pending = this.performanceRequests.get(suggestion.requestId);
    if (
      !pending
      || pending.segmentId !== suggestion.segmentId
      || pending.revision !== suggestion.segmentRevision
      || pending.catalogRevision !== suggestion.catalogRevision
      || suggestion.catalogRevision !== catalog.revision
      || !sameTextAnchor(pending.textAnchor, suggestion.textAnchor)
      || !containedTextAnchor(pending.textAnchor, suggestion.expressionTextAnchor)
    ) {
      return;
    }
    if (!event.provisional) this.performanceRequests.delete(suggestion.requestId);
    if (
      suggestion.contractVersion !== PERFORMANCE_PLANNING_V2_CONTRACT_VERSION
      || !Array.isArray(suggestion.expressionCandidates)
      || !Array.isArray(suggestion.actions)
    ) {
      return;
    }
    const segmentIndex = this.plan.segments.findIndex(segment => (
      segment.id === suggestion.segmentId
    ));
    if (segmentIndex < this.nextSegmentIndex || segmentIndex < 0) return;
    const segment = this.plan.segments[segmentIndex]!;
    const slots = this.performanceSlots.get(segment.id);
    const capabilities = this.snapshot.capabilities;
    const planning = this.options.performancePlanning;
    if (!slots || !capabilities || !planning) return;
    let resolved;
    try {
      resolved = resolveExpression({
        catalog,
        avatarState: this.snapshot.state,
        resolutionId: performanceRequestKey(suggestion.segmentId, suggestion.textAnchor),
        randomSeed: this.expressionRandomSeed,
        nowMs: this.clock(),
        candidates: suggestion.expressionCandidates,
        ...(suggestion.affect ? { affect: suggestion.affect } : {}),
        personaTags: planning.persona.styleTags,
        sceneTags: planning.scene.modeTags,
        ...(this.snapshot.expression.currentKey
          ? { currentExpressionKey: this.snapshot.expression.currentKey }
          : {}),
        history: [...this.expressionHistory],
      });
    }
    catch {
      return;
    }
    const updated = applyPerformanceSuggestionV2(
      segment,
      suggestion,
      resolved,
      slots,
      capabilities,
      this.policy,
    );
    this.plan.segments[segmentIndex] = updated;
    if (this.timeline?.segmentId === updated.id) {
      this.timeline.update(updated);
      this.applyTimeline(this.snapshot.playback.positionMs);
    }
  }

  private applyMouth(positionMs: number): void {
    const mouthOpen = sampleAmplitude(this.currentSource?.amplitude, positionMs);
    this.applyMouthValue(mouthOpen, positionMs);
  }

  private applyMouthValue(value: number, positionMs: number): void {
    this.layers.mouth = {
      ParamMouthOpenY: { value: this.lipSyncEnvelope.update(value, positionMs) },
    };
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

  private transitionSpeechBubble(event: AvatarEvent): {
    state: SpeechBubbleState;
    effects: RuntimeEffect[];
  } {
    const current = this.snapshot.speechBubble;
    if (event.type === 'runtime.text-fallback-selected') {
      const segment = this.segmentById(event.segmentId);
      if (!segment) return { state: current, effects: [] };
      const effects: RuntimeEffect[] = current.phase === 'holding'
        ? [{
            type: 'speech-bubble.cancel-dismiss',
            generation: this.snapshot.generation,
            presentationId: current.presentationId,
          }]
        : [];
      effects.push({
        type: 'speech-bubble.schedule-dismiss',
        generation: this.snapshot.generation,
        presentationId: event.presentationId,
        delayMs: event.durationMs,
      });
      return {
        state: {
          phase: 'holding',
          presentationId: event.presentationId,
          segmentId: segment.id,
          displayText: segment.displayText,
          config: { mode: 'complete', dismissDelayMs: event.durationMs },
          positionMs: 0,
          durationMs: event.durationMs,
        },
        effects,
      };
    }
    if (event.type === 'presentation.chat-bubble-requested') {
      const presentationId = current.presentationId + 1;
      const delayMs = event.dismissDelayMs ?? DEFAULT_SPEECH_BUBBLE_DISMISS_DELAY_MS;
      const effects: RuntimeEffect[] = current.phase === 'holding'
        ? [{
            type: 'speech-bubble.cancel-dismiss',
            generation: this.snapshot.generation,
            presentationId: current.presentationId,
          }]
        : [];
      effects.push({
        type: 'speech-bubble.schedule-dismiss',
        generation: this.snapshot.generation,
        presentationId,
        delayMs,
      });
      return {
        state: {
          phase: 'holding',
          presentationId,
          segmentId: null,
          displayText: event.text,
          config: { mode: 'complete', dismissDelayMs: delayMs },
          positionMs: 0,
        },
        effects,
      };
    }
    if (event.type === 'playback.started') {
      const segment = this.segmentById(event.segmentId);
      if (!segment) return { state: current, effects: [] };
      const config = speechBubbleConfig(segment, this.currentSource);
      const effects = current.phase === 'holding'
        ? [{
            type: 'speech-bubble.cancel-dismiss' as const,
            generation: this.snapshot.generation,
            presentationId: current.presentationId,
          }]
        : [];
      return {
        state: {
          phase: 'playing',
          presentationId: current.presentationId + 1,
          segmentId: segment.id,
          displayText: segment.displayText,
          ...(config ? { config } : {}),
          positionMs: event.positionMs,
          ...(this.currentSource?.durationMs !== undefined ? { durationMs: this.currentSource.durationMs } : {}),
        },
        effects,
      };
    }
    if (
      current.phase === 'playing'
      && 'segmentId' in event
      && event.segmentId === current.segmentId
      && (
        event.type === 'playback.progress'
        || event.type === 'playback.level'
        || event.type === 'playback.stalled'
        || event.type === 'playback.recovered'
        || event.type === 'playback.paused'
        || event.type === 'playback.resumed'
      )
    ) {
      return { state: { ...current, positionMs: event.positionMs }, effects: [] };
    }
    if (event.type === 'playback.completed' && current.phase === 'playing' && event.segmentId === current.segmentId) {
      const delayMs = current.config?.dismissDelayMs ?? DEFAULT_SPEECH_BUBBLE_DISMISS_DELAY_MS;
      return {
        state: { ...current, phase: 'holding', positionMs: event.positionMs },
        effects: [{
          type: 'speech-bubble.schedule-dismiss',
          generation: this.snapshot.generation,
          presentationId: current.presentationId,
          delayMs,
        }],
      };
    }
    if (
      event.type === 'runtime.speech-bubble-dismissed'
      && current.phase === 'holding'
      && event.presentationId === current.presentationId
    ) {
      return { state: hiddenSpeechBubble(current.presentationId), effects: [] };
    }
    if (
      event.type === 'user.interrupt-requested'
      || event.type === 'playback.failed'
      || event.type === 'playback.interrupted'
    ) {
      const effects = current.phase === 'holding'
        ? [{
            type: 'speech-bubble.cancel-dismiss' as const,
            generation: this.snapshot.generation,
            presentationId: current.presentationId,
          }]
        : [];
      return { state: hiddenSpeechBubble(current.presentationId), effects };
    }
    return { state: current, effects: [] };
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
          requestId: effect.command.requestId,
          actionId: effect.command.actionId,
          error,
        });
        break;
      case 'renderer.set-expression':
        this.dispatch({ type: 'renderer.failed', error });
        break;
      case 'renderer.apply-frame':
        this.dispatch({ type: 'renderer.failed', error });
        break;
      case 'renderer.stop-motion':
        this.dispatch({
          type: 'renderer.motion-interrupted',
          generation: effect.generation,
          requestId: effect.requestId,
          actionId: effect.actionId,
        });
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
      case 'performance.cancel':
      case 'performance.cancel-v2':
      case 'speech-bubble.schedule-dismiss':
      case 'speech-bubble.cancel-dismiss':
        this.dispatch({ type: 'runtime.effect-failed', generation: effect.generation, error });
        break;
      case 'performance.infer':
        this.dispatch({
          type: 'performance.suggestion-failed',
          generation: effect.generation,
          planId: effect.request.planId,
          requestId: effect.request.requestId,
          segmentId: effect.request.segmentId,
          segmentRevision: effect.request.segmentRevision,
          error,
        });
        break;
      case 'performance.infer-v2':
        this.dispatch({
          type: 'performance.suggestion-v2-failed',
          generation: effect.generation,
          planId: effect.request.planId,
          requestId: effect.request.requestId,
          segmentId: effect.request.segmentId,
          segmentRevision: effect.request.segmentRevision,
          catalogRevision: effect.request.catalogRevision,
          error,
        });
        break;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private applyBoundExpression(emotion: Emotion, intensity: number): void {
    const binding = this.options.emotionBindings?.[emotion];
    if (!binding) return;
    this.execute({
      type: 'renderer.set-expression',
      generation: this.snapshot.generation,
      command: {
        expressionKey: emotion,
        emotion,
        expressionId: binding.expression,
        intensity,
      },
    });
  }

  private applyBoundExpressionKey(expressionKey: string, intensity: number): void {
    const binding = this.options.expressionCatalog?.bindings[expressionKey];
    if (!binding) return;
    this.execute({
      type: 'renderer.set-expression',
      generation: this.snapshot.generation,
      command: {
        expressionKey,
        expressionId: binding.expression,
        intensity,
      },
    });
  }

  private resetBoundExpression(): void {
    const catalog = this.options.expressionCatalog;
    if (catalog) {
      const binding = catalog.bindings[catalog.defaultExpressionKey];
      if (!binding) return;
      this.execute({
        type: 'renderer.set-expression',
        generation: this.snapshot.generation,
        command: {
          expressionKey: catalog.defaultExpressionKey,
          expressionId: binding.expression,
          intensity: 0,
        },
      });
      return;
    }
    if (!this.options.emotionBindings || Object.keys(this.options.emotionBindings).length === 0) {
      return;
    }
    this.execute({
      type: 'renderer.set-expression',
      generation: this.snapshot.generation,
      command: {
        expressionKey: 'neutral',
        emotion: 'neutral',
        expressionId: this.options.emotionBindings.neutral?.expression ?? null,
        intensity: 0,
      },
    });
  }

  private restoreDefaultExpressionSnapshot(): void {
    const catalog = this.options.expressionCatalog;
    if (!catalog) return;
    this.snapshot = {
      ...this.snapshot,
      expression: {
        currentKey: catalog.defaultExpressionKey,
        intensity: 0,
        catalogRevision: catalog.revision,
        startedAtMs: null,
        holdUntilMs: null,
      },
    };
  }

  private validateExplicitExpressions(plan: PerformancePlan): void {
    const catalog = this.options.expressionCatalog;
    for (const segment of plan.segments) {
      const expressions = [
        ...(segment.expression ? [segment.expression] : []),
        ...(segment.expressionCues ?? []),
      ];
      for (const expression of expressions) {
        if (!catalog?.bindings[expression.expressionKey]) {
          throw new Error(
            `Expression ${expression.expressionKey} is not available in the active character catalog`,
          );
        }
      }
    }
  }

  private nextActionRandom(): number {
    const value = this.actionRandom();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError('actionRandom must return a value in [0, 1)');
    }
    return value;
  }

  private logPerformance(event: string, data: Record<string, unknown>): void {
    this.options.performanceLogger?.(event, data);
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

function hiddenSpeechBubble(presentationId: number): SpeechBubbleState {
  return { phase: 'hidden', presentationId, segmentId: null, displayText: '', positionMs: 0 };
}

function speechBubbleConfig(
  segment: Readonly<PerformanceSegment>,
  source: Readonly<AudioSource> | null,
): import('../../contracts/src/index.ts').SpeechBubbleConfig | undefined {
  const configured = segment.bubble ? structuredClone(segment.bubble) : undefined;
  const aligned = source?.textCues;
  if (!aligned?.length || aligned.map(cue => cue.text).join('') !== segment.displayText) return configured;
  return { ...(configured ?? { mode: 'complete' as const }), cues: structuredClone(aligned) };
}

function gazeParameterLayer(frame: Record<string, number>): Record<string, ParameterValue> {
  return Object.fromEntries(Object.entries(frame).map(([parameter, value]) => (
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
  if (!samples?.length) return 0;
  let selected = samples[0]!.value;
  for (const sample of samples) {
    if (sample.atMs > positionMs) break;
    selected = sample.value;
  }
  return Math.max(0, Math.min(1, selected));
}

function sameTextAnchor(
  left: PerformanceTextAnchor | undefined,
  right: PerformanceTextAnchor | undefined,
): boolean {
  return left !== undefined
    && right !== undefined
    && left.clauseIndex === right.clauseIndex
    && left.clauseCount === right.clauseCount
    && left.startCharacter === right.startCharacter
    && left.endCharacter === right.endCharacter
    && left.totalCharacters === right.totalCharacters;
}

function containedTextAnchor(
  clause: PerformanceTextAnchor | undefined,
  trigger: PerformanceTextAnchor | undefined,
): boolean {
  return clause !== undefined
    && trigger !== undefined
    && clause.clauseIndex === trigger.clauseIndex
    && clause.clauseCount === trigger.clauseCount
    && clause.totalCharacters === trigger.totalCharacters
    && trigger.startCharacter >= clause.startCharacter
    && trigger.endCharacter > trigger.startCharacter
    && trigger.endCharacter <= clause.endCharacter;
}

function legacyActionCatalog(): CharacterActionCatalog {
  const actionIds = ['nod', 'shake', 'tap', 'greet'];
  return {
    revision: 0,
    descriptors: actionIds.map(actionId => ({
      actionId,
      label: actionId,
      semanticTags: [actionId],
      prototypeTexts: [actionId],
      allowedAnchors: ['segment-start'],
      compatibleAvatarStates: ['idle', 'listening', 'thinking', 'speaking', 'presenting'],
      scene: {},
      speech: 'allow',
      priority: 0,
      cooldownMs: 0,
      maxQueueAgeMs: 5_000,
      busyPolicy: 'enqueue',
      triggers: [{
        ruleId: 'performance',
        trigger: 'performance.action',
        mode: 'required',
        chance: 1,
        weight: 1,
      }],
    })),
    bindings: Object.fromEntries(actionIds.map(actionId => [actionId, {
      type: 'live2d-motion' as const,
      group: actionId,
      index: 0,
      mode: 'once' as const,
      expectedDurationMs: 1_200,
    }])),
  };
}
