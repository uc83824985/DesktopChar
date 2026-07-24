export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'presenting';
export type PlaybackStatus = 'idle' | 'loading' | 'buffering' | 'playing' | 'paused' | 'stopped';

export type Emotion =
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'angry'
  | 'surprised'
  | 'thinking';

export type AvatarAction = 'nod' | 'shake' | 'tap' | 'greet';
export type SemanticBeat = 'start' | 'middle' | 'end';
export type ActionPolicy =
  | 'enqueue'
  | 'replace'
  | 'ignore-if-busy'
  | 'interrupt-lower-priority';

export interface EmotionCue {
  emotion: Emotion;
  intensity: number;
  atMs?: number;
}

export interface ExpressionCue {
  expressionKey: ExpressionKey;
  intensity: number;
  atMs?: number;
  holdMs?: number;
}

/** Character-owned mapping from a semantic Runtime emotion to a renderer resource. */
export interface EmotionBinding {
  /** Live2D expression name from the model3 Expressions catalog, or null to reset. */
  expression: string | null;
}

export type EmotionBindings = Partial<Record<Emotion, EmotionBinding>>;

/**
 * Character-scoped logical expression identifier.
 *
 * This is deliberately not a Live2D expression name or asset path. It is
 * stable only inside one CharacterExpressionCatalog revision.
 */
export type ExpressionKey = string;

export interface AffectVector {
  valence: number;
  arousal: number;
  approval: number;
  engagement: number;
  certainty: number;
}

export interface ExpressionHoldRange {
  minMs: number;
  maxMs: number;
}

/**
 * Asset-free semantic projection exposed to inference and selection logic.
 */
export interface ExpressionDescriptor {
  expressionKey: ExpressionKey;
  label: string;
  semanticTags: string[];
  prototypeTexts: string[];
  affectPrototype?: Partial<AffectVector>;
  baseWeight: number;
  cooldownMs: number;
  holdMs: ExpressionHoldRange;
  compatibleAvatarStates: AvatarState[];
}

/**
 * Character-owned renderer binding. This must never be sent to an inference
 * Provider.
 */
export interface ExpressionBinding {
  expression: string | null;
}

export interface CharacterExpressionCatalog {
  revision: number;
  defaultExpressionKey: ExpressionKey;
  descriptors: ExpressionDescriptor[];
  bindings: Record<ExpressionKey, ExpressionBinding>;
}

export interface ExpressionCandidate {
  expressionKey: ExpressionKey;
  confidence: number;
  intensity: number;
}

export interface ExpressionSelectionHistoryEntry {
  expressionKey: ExpressionKey;
  selectedAtMs: number;
}

export interface ResolvedExpression {
  expressionKey: ExpressionKey;
  intensity: number;
  holdMs: number;
  score: number;
  source: 'candidate' | 'affect' | 'fallback';
}

export interface ActionCue {
  id: string;
  action: AvatarAction;
  atMs?: number;
  beat?: SemanticBeat;
  priority?: number;
  policy?: ActionPolicy;
}

export type SpeechBubbleMode = 'stream' | 'karaoke' | 'complete';

export interface SpeechBubbleCue {
  text: string;
  atMs: number;
  durationMs?: number;
}

export interface SpeechBubbleConfig {
  mode: SpeechBubbleMode;
  cues?: SpeechBubbleCue[];
  charactersPerSecond?: number;
  dismissDelayMs?: number;
}

export type SpeechBubblePhase = 'hidden' | 'playing' | 'holding';

export interface SpeechBubbleState {
  phase: SpeechBubblePhase;
  presentationId: number;
  segmentId: string | null;
  displayText: string;
  config?: SpeechBubbleConfig;
  positionMs: number;
  durationMs?: number;
}

export interface PerformanceSegment {
  id: string;
  sequence: number;
  displayText: string;
  speechText: string;
  emotion?: EmotionCue;
  expression?: ExpressionCue;
  actions?: ActionCue[];
  bubble?: SpeechBubbleConfig;
}

export interface PerformancePlan {
  id: string;
  segments: PerformanceSegment[];
}

export const PERFORMANCE_PLANNING_CONTRACT_VERSION = 'desktop-char.performance-planning.v1' as const;

export type PerformanceAnchor = 'segment-start' | 'after-clause' | 'segment-end';

export interface PersonaPerformanceProjection {
  id: string;
  styleTags: string[];
}

export interface ScenePerformanceProjection {
  id: string;
  modeTags: string[];
}

export interface AvatarPerformanceProjection {
  state: AvatarState;
  currentEmotion: Emotion;
}

export interface PerformanceActionDescriptor {
  actionId: AvatarAction;
  label: string;
  tags: string[];
  allowedAnchors: PerformanceAnchor[];
}

export interface PerformancePlanningRequest {
  contractVersion: typeof PERFORMANCE_PLANNING_CONTRACT_VERSION;
  requestId: string;
  planId: string;
  segmentId: string;
  segmentRevision: number;
  text: string;
  persona: PersonaPerformanceProjection;
  scene: ScenePerformanceProjection;
  avatar: AvatarPerformanceProjection;
  emotions: Emotion[];
  actions: PerformanceActionDescriptor[];
}

export interface PerformanceEmotionSuggestion {
  emotion: Emotion;
  intensity: number;
  confidence: number;
  anchor: 'segment-start';
}

export interface PerformanceActionSuggestion {
  actionId: AvatarAction;
  confidence: number;
  anchor: PerformanceAnchor;
  clauseIndex?: number;
}

export interface LocalPerformanceSuggestion {
  contractVersion: typeof PERFORMANCE_PLANNING_CONTRACT_VERSION;
  requestId: string;
  segmentId: string;
  segmentRevision: number;
  source: 'model' | 'rules';
  provider: string;
  emotion?: PerformanceEmotionSuggestion;
  actions: PerformanceActionSuggestion[];
}

export const PERFORMANCE_PLANNING_V2_CONTRACT_VERSION = 'desktop-char.performance-planning.v2' as const;

export interface AvatarPerformanceProjectionV2 {
  state: AvatarState;
  currentExpressionKey: ExpressionKey;
  coarseEmotion?: Emotion;
}

export interface PerformancePlanningRequestV2 {
  contractVersion: typeof PERFORMANCE_PLANNING_V2_CONTRACT_VERSION;
  requestId: string;
  planId: string;
  segmentId: string;
  segmentRevision: number;
  catalogRevision: number;
  defaultExpressionKey: ExpressionKey;
  text: string;
  persona: PersonaPerformanceProjection;
  scene: ScenePerformanceProjection;
  avatar: AvatarPerformanceProjectionV2;
  expressions: ExpressionDescriptor[];
  actions: PerformanceActionDescriptor[];
}

export interface LocalPerformanceSuggestionV2 {
  contractVersion: typeof PERFORMANCE_PLANNING_V2_CONTRACT_VERSION;
  requestId: string;
  segmentId: string;
  segmentRevision: number;
  catalogRevision: number;
  source: 'model' | 'rules';
  provider: string;
  affect?: AffectVector;
  expressionCandidates: ExpressionCandidate[];
  actions: PerformanceActionSuggestion[];
}

export interface PerformanceInferenceCapabilities {
  structuredOutput: 'json-schema' | 'json-object' | 'prompt-only';
  thinkingControl: 'supported' | 'unsupported';
  streaming: boolean;
  maxContextTokens?: number;
}

export interface VisemeTiming {
  atMs: number;
  durationMs: number;
  viseme: string;
  weight?: number;
}

export interface AmplitudeSample {
  atMs: number;
  value: number;
}

export type AudioCodec = 'pcm_s16le' | 'pcm_f32le' | 'wav' | 'mp3' | 'ogg' | 'opus';

interface AudioSourceBase {
  requestId: string;
  uri: string;
  mimeType: string;
  durationMs?: number;
  visemes?: VisemeTiming[];
  amplitude?: AmplitudeSample[];
  textCues?: SpeechBubbleCue[];
}

export interface AudioArtifactSource extends AudioSourceBase {
  delivery: 'artifact';
  codec?: AudioCodec;
  sampleRateHz?: number;
  channels?: number;
}

export interface AudioStreamSource extends AudioSourceBase {
  delivery: 'stream';
  codec: AudioCodec;
  sampleRateHz: number;
  channels: number;
}

export type AudioSource = AudioArtifactSource | AudioStreamSource;

export interface RuntimeError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface AvatarCapabilities {
  emotions: Emotion[];
  actions: AvatarAction[];
  parameters: string[];
  supportsMouthForm: boolean;
  supportsGaze: boolean;
  supportsHitTest: boolean;
}

export interface EmotionState {
  current: Emotion;
  intensity: number;
}

export interface GestureState {
  actionId: string | null;
  action: AvatarAction | null;
  queueLength: number;
}

export interface GazeState {
  x: number;
  y: number;
  active: boolean;
}

export interface GazeDirectionProfile {
  limit: number;
  exponent: number;
}

export interface GazeAxisProfile {
  negative: GazeDirectionProfile;
  positive: GazeDirectionProfile;
  deadZone: number;
}

export interface GazeSmoothingProfile {
  /** Time for head parameters to complete 90% of a target transition. */
  headResponseMs: number;
  /** Time for eye parameters to complete 90% of a target transition. */
  eyeResponseMs: number;
}

export const DEFAULT_GAZE_SMOOTHING_PROFILE: Readonly<GazeSmoothingProfile> = Object.freeze({
  headResponseMs: 120,
  eyeResponseMs: 45,
});

export interface GazeProfile {
  headX: GazeAxisProfile;
  headY: GazeAxisProfile;
  eyeX: GazeAxisProfile;
  eyeY: GazeAxisProfile;
  smoothing: GazeSmoothingProfile;
}

export interface LipSyncProfile {
  gain: number;
  /** Time for the mouth envelope to complete 90% of an opening transition. */
  attackMs: number;
  /** Time for the mouth envelope to complete 90% of a closing transition. */
  releaseMs: number;
  /** Keeps a recent peak briefly so short audio pulses are not reduced to one frame. */
  peakHoldMs: number;
}

export const DEFAULT_LIP_SYNC_PROFILE: Readonly<LipSyncProfile> = Object.freeze({
  gain: 1,
  attackMs: 30,
  releaseMs: 100,
  peakHoldMs: 25,
});

export interface AvatarSnapshot {
  state: AvatarState;
  generation: number;
  planId: string | null;
  segmentId: string | null;
  sequence: number | null;
  playback: {
    status: PlaybackStatus;
    positionMs: number;
  };
  speechBubble: SpeechBubbleState;
  emotion: EmotionState;
  expression: {
    currentKey: ExpressionKey | null;
    intensity: number;
    catalogRevision: number | null;
    startedAtMs: number | null;
    holdUntilMs: number | null;
  };
  gesture: GestureState;
  gaze: GazeState;
  interrupted: boolean;
  capabilities: AvatarCapabilities | null;
  lastError?: RuntimeError;
}

export type UserEvent =
  | { type: 'user.interrupt-requested' }
  | { type: 'user.pause-requested' }
  | { type: 'user.resume-requested' }
  | { type: 'user.gaze-follow-enabled' }
  | { type: 'user.gaze-follow-disabled' }
  | { type: 'user.look-target-changed'; x: number; y: number }
  | { type: 'user.avatar-clicked'; hitArea: string };

export type PresentationEvent =
  | { type: 'presentation.chat-bubble-requested'; text: string; dismissDelayMs?: number };

export type PlanEvent =
  | { type: 'plan.submitted'; plan: PerformancePlan }
  | { type: 'plan.segment-appended'; planId: string; segment: PerformanceSegment }
  | { type: 'plan.completed'; planId: string }
  | { type: 'plan.failed'; planId: string; error: RuntimeError };

export type TtsEvent =
  | { type: 'tts.segment-ready'; generation: number; segmentId: string; sequence: number; audio: AudioSource }
  | { type: 'tts.segment-failed'; generation: number; segmentId: string; sequence: number; error: RuntimeError }
  | { type: 'tts.plan-completed'; generation: number; planId: string };

export type PerformanceInferenceEvent =
  | {
      type: 'performance.suggestion-ready';
      generation: number;
      planId: string;
      suggestion: LocalPerformanceSuggestion;
    }
  | {
      type: 'performance.suggestion-failed';
      generation: number;
      planId: string;
      requestId: string;
      segmentId: string;
      segmentRevision: number;
      error: RuntimeError;
    };

export type PerformanceInferenceV2Event =
  | {
      type: 'performance.suggestion-v2-ready';
      generation: number;
      planId: string;
      suggestion: LocalPerformanceSuggestionV2;
    }
  | {
      type: 'performance.suggestion-v2-failed';
      generation: number;
      planId: string;
      requestId: string;
      segmentId: string;
      segmentRevision: number;
      catalogRevision: number;
      error: RuntimeError;
    };

export type PlaybackEvent =
  | { type: 'playback.buffering'; generation: number; segmentId: string; positionMs: number; bufferedMs: number }
  | { type: 'playback.started'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.progress'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.level'; generation: number; segmentId: string; positionMs: number; value: number }
  | { type: 'playback.stalled'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.recovered'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.paused'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.resumed'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.completed'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.interrupted'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.failed'; generation: number; segmentId: string; error: RuntimeError };

export type RendererEvent =
  | { type: 'renderer.ready'; capabilities: AvatarCapabilities }
  | { type: 'renderer.frame-tick'; deltaMs: number }
  | { type: 'renderer.motion-completed'; generation: number; actionId: string }
  | { type: 'renderer.motion-failed'; generation: number; actionId: string; error: RuntimeError }
  | { type: 'renderer.failed'; error: RuntimeError };

export type RuntimeInternalEvent =
  | { type: 'runtime.segment-selected'; generation: number; segmentId: string; sequence: number }
  | { type: 'runtime.text-fallback-selected'; generation: number; segmentId: string; sequence: number; presentationId: number; durationMs: number }
  | { type: 'runtime.text-fallback-completed'; generation: number; segmentId: string; sequence: number }
  | { type: 'runtime.plan-completed'; generation: number; planId: string }
  | { type: 'runtime.speech-bubble-dismissed'; generation: number; presentationId: number }
  | { type: 'runtime.effect-failed'; generation: number; error: RuntimeError }
  | { type: 'timeline.emotion-cue'; generation: number; cue: EmotionCue }
  | {
      type: 'timeline.expression-cue';
      generation: number;
      catalogRevision: number;
      startedAtMs: number;
      cue: ExpressionCue;
    }
  | { type: 'timeline.action-cue'; generation: number; cue: ActionCue };

export type AvatarEvent =
  | UserEvent
  | PresentationEvent
  | PlanEvent
  | TtsEvent
  | PerformanceInferenceEvent
  | PerformanceInferenceV2Event
  | PlaybackEvent
  | RendererEvent
  | RuntimeInternalEvent;

export type ParameterBlendMode = 'add' | 'multiply' | 'overwrite' | 'lerp';

export interface ParameterValue {
  value: number;
  weight?: number;
  blend?: ParameterBlendMode;
}

export type ParameterFrame = Record<string, number>;

export interface MotionCommand {
  actionId: string;
  action: AvatarAction;
  priority: number;
}

export interface MotionResult {
  actionId: string;
  completed: boolean;
}

export interface ExpressionCommand {
  expressionKey: ExpressionKey;
  emotion?: Emotion;
  expressionId: string | null;
  intensity: number;
}

export type RuntimeEffect =
  | { type: 'tts.synthesize'; generation: number; segment: PerformanceSegment }
  | { type: 'tts.cancel'; generation: number }
  | { type: 'performance.infer'; generation: number; request: PerformancePlanningRequest }
  | { type: 'performance.cancel'; generation: number }
  | { type: 'performance.infer-v2'; generation: number; request: PerformancePlanningRequestV2 }
  | { type: 'performance.cancel-v2'; generation: number }
  | { type: 'audio.play'; generation: number; segmentId: string; source: AudioSource }
  | { type: 'audio.pause'; generation: number }
  | { type: 'audio.resume'; generation: number }
  | { type: 'audio.stop'; generation: number }
  | { type: 'speech-bubble.schedule-dismiss'; generation: number; presentationId: number; delayMs: number }
  | { type: 'speech-bubble.cancel-dismiss'; generation: number; presentationId: number }
  | { type: 'renderer.apply-frame'; frame: ParameterFrame }
  | { type: 'renderer.set-expression'; generation: number; command: ExpressionCommand }
  | { type: 'renderer.play-motion'; generation: number; command: MotionCommand };

export interface RuntimeTransition {
  snapshot: AvatarSnapshot;
  effects: RuntimeEffect[];
}
