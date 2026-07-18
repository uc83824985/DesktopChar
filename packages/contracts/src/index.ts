export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking';

export type Emotion =
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'angry'
  | 'surprised'
  | 'thinking';

export type AvatarAction = 'nod' | 'shake' | 'tap' | 'greet';
export type SemanticBeat = 'start' | 'middle' | 'end';

export interface PerformanceSegment {
  text: string;
  emotion?: Emotion;
  intensity?: number;
  action?: AvatarAction;
  beat?: SemanticBeat;
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

export type PlaybackEvent =
  | { type: 'started'; positionMs: number }
  | { type: 'progress'; positionMs: number }
  | { type: 'paused'; positionMs: number }
  | { type: 'resumed'; positionMs: number }
  | { type: 'interrupted'; positionMs: number }
  | { type: 'ended'; positionMs: number };

export interface AvatarControlPort {
  setState(state: AvatarState): void;
  setEmotion(emotion: Emotion, intensity?: number): void;
  playAction(action: AvatarAction): Promise<void>;
  speak(audio: AudioSource): Promise<void>;
  lookAt(x: number, y: number): void;
  interrupt(): Promise<void>;
}
