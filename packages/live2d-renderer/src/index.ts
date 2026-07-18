import type { AvatarAction, Emotion } from '../../contracts/src/index';

export interface Live2DModelSource {
  modelJsonUrl: string;
  id: string;
}

export interface Live2DRenderer {
  load(source: Live2DModelSource): Promise<void>;
  unload(): Promise<void>;
  resize(width: number, height: number): void;
  setExpression(emotion: Emotion, intensity: number): void;
  playMotion(action: AvatarAction): Promise<void>;
  setParameter(id: string, value: number, weight?: number): void;
  lookAt(x: number, y: number): void;
  hitTest(x: number, y: number): string[];
}

// 具体 Pixi/Live2D SDK 实现在后续渲染小样选型后放入 adapters/。
