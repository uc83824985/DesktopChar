import type {
  AvatarAction,
  AvatarControlPort,
  AvatarState,
  AudioSource,
  Emotion,
  PerformancePlan,
} from '../../contracts/src/index';

export interface AvatarPlanner {
  normalize(plan: PerformancePlan): PerformancePlan;
}

export interface PerformanceTimeline {
  start(plan: PerformancePlan): Promise<void>;
  cancel(): void;
}

export interface ParameterLayers {
  base: Record<string, number>;
  gaze: Record<string, number>;
  expression: Record<string, number>;
  gesture: Record<string, number>;
  mouth: Record<string, number>;
}

export interface ParameterMixer {
  // Mouth 必须最后合成，保证 motion 不覆盖口型。
  mix(layers: ParameterLayers): Record<string, number>;
}

export abstract class AvatarRuntime implements AvatarControlPort {
  abstract setState(state: AvatarState): void;
  abstract setEmotion(emotion: Emotion, intensity?: number): void;
  abstract playAction(action: AvatarAction): Promise<void>;
  abstract speak(audio: AudioSource): Promise<void>;
  abstract lookAt(x: number, y: number): void;
  abstract interrupt(): Promise<void>;
}
