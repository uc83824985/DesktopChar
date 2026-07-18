import type { AvatarAction, Emotion, MotionResult } from '../../contracts/src/index.ts';

export interface CoreParameter {
  id: string;
  minimum: number;
  maximum: number;
  defaultValue: number;
}

export interface CoreModelDescriptor {
  parameters: CoreParameter[];
  emotions: Partial<Record<Emotion, string>>;
  actions: Partial<Record<AvatarAction, string>>;
  hitAreas: string[];
  aliases?: Record<string, string>;
}

export interface Live2DModelSource {
  id: string;
  modelJsonUrl: string;
}

export interface Live2DCoreModel {
  readonly descriptor: CoreModelDescriptor;
  setParameter(id: string, value: number): void;
  playMotion(group: string): Promise<void>;
  hitTest(x: number, y: number): string[];
  resize(width: number, height: number): void;
  dispose(): Promise<void>;
}

export interface Live2DCoreModelPort {
  load(source: Live2DModelSource): Promise<Live2DCoreModel>;
}

export interface Live2DRendererPort {
  load(source: Live2DModelSource): Promise<import('../../contracts/src/index.ts').AvatarCapabilities>;
  applyFrame(frame: import('../../contracts/src/index.ts').ParameterFrame): void;
  playMotion(command: import('../../contracts/src/index.ts').MotionCommand): Promise<MotionResult>;
  hitTest(x: number, y: number): string[];
  resize(width: number, height: number): void;
  unload(): Promise<void>;
}
