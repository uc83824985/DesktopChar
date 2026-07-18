import type {
  AvatarCapabilities,
  MotionCommand,
  MotionResult,
  ParameterFrame,
} from '../../contracts/src/index.ts';

export interface Live2DModelSource {
  modelJsonUrl: string;
  id: string;
}

export interface Live2DRendererPort {
  load(source: Live2DModelSource): Promise<AvatarCapabilities>;
  applyFrame(frame: ParameterFrame): void;
  playMotion(command: MotionCommand): Promise<MotionResult>;
  hitTest(x: number, y: number): string[];
  resize(width: number, height: number): void;
  unload(): Promise<void>;
}

// 具体 Pixi/Live2D SDK 实现在渲染小样选型后放入 adapters/。
