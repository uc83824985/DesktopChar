export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking';
export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped';

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

export interface ActionCue {
  id: string;
  action: AvatarAction;
  atMs?: number;
  beat?: SemanticBeat;
  priority?: number;
  policy?: ActionPolicy;
}

export interface PerformanceSegment {
  id: string;
  sequence: number;
  displayText: string;
  speechText: string;
  emotion?: EmotionCue;
  actions?: ActionCue[];
}

export interface PerformancePlan {
  id: string;
  segments: PerformanceSegment[];
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

export interface AudioSource {
  uri: string;
  durationMs?: number;
  visemes?: VisemeTiming[];
  amplitude?: AmplitudeSample[];
}

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
  emotion: EmotionState;
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
  | { type: 'user.look-target-changed'; x: number; y: number }
  | { type: 'user.avatar-clicked'; hitArea: string };

export type PlanEvent =
  | { type: 'plan.submitted'; plan: PerformancePlan }
  | { type: 'plan.segment-appended'; planId: string; segment: PerformanceSegment }
  | { type: 'plan.completed'; planId: string }
  | { type: 'plan.failed'; planId: string; error: RuntimeError };

export type TtsEvent =
  | { type: 'tts.segment-ready'; generation: number; segmentId: string; sequence: number; audio: AudioSource }
  | { type: 'tts.segment-failed'; generation: number; segmentId: string; sequence: number; error: RuntimeError }
  | { type: 'tts.plan-completed'; generation: number; planId: string };

export type PlaybackEvent =
  | { type: 'playback.started'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.progress'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.paused'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.resumed'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.completed'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.interrupted'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.failed'; generation: number; segmentId: string; error: RuntimeError };

export type RendererEvent =
  | { type: 'renderer.ready'; capabilities: AvatarCapabilities }
  | { type: 'renderer.motion-completed'; generation: number; actionId: string }
  | { type: 'renderer.motion-failed'; generation: number; actionId: string; error: RuntimeError }
  | { type: 'renderer.failed'; error: RuntimeError };

export type AvatarEvent = UserEvent | PlanEvent | TtsEvent | PlaybackEvent | RendererEvent;

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

export type RuntimeEffect =
  | { type: 'tts.synthesize'; generation: number; segment: PerformanceSegment }
  | { type: 'tts.cancel'; generation: number }
  | { type: 'audio.play'; generation: number; segmentId: string; source: AudioSource }
  | { type: 'audio.pause'; generation: number }
  | { type: 'audio.resume'; generation: number }
  | { type: 'audio.stop'; generation: number }
  | { type: 'renderer.apply-frame'; frame: ParameterFrame }
  | { type: 'renderer.play-motion'; generation: number; command: MotionCommand };

export interface RuntimeTransition {
  snapshot: AvatarSnapshot;
  effects: RuntimeEffect[];
}
