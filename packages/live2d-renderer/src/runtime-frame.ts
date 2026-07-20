import type { ParameterFrame } from '../../contracts/src/index.ts';

export interface CubismParameterTarget {
  setParameterValueById(id: string, value: number): void;
}

export interface RuntimeParameterFrameOptions {
  aliases?: Readonly<Record<string, string>>;
}

/**
 * Keeps the latest complete Runtime frame until the Live2D model reaches its
 * beforeModelUpdate hook. Applying here makes Runtime the final parameter
 * writer after motions, focus, expressions, and physics have run.
 */
export class RuntimeParameterFrame {
  private frame: ParameterFrame = {};
  private readonly aliases: Readonly<Record<string, string>>;

  constructor(options: RuntimeParameterFrameOptions = {}) {
    this.aliases = options.aliases ?? {};
  }

  replace(frame: ParameterFrame): void {
    this.frame = Object.fromEntries(
      Object.entries(frame).filter(([, value]) => Number.isFinite(value)),
    );
  }

  apply(target: CubismParameterTarget): void {
    for (const [publicId, value] of Object.entries(this.frame)) {
      target.setParameterValueById(this.aliases[publicId] ?? publicId, value);
    }
  }

  current(): ParameterFrame {
    return { ...this.frame };
  }
}
