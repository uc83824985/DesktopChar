import type {
  AvatarCapabilities,
  ParameterFrame,
  ParameterValue,
} from '../../contracts/src/index.ts';

export interface ParameterLayers {
  base: Record<string, ParameterValue>;
  gaze: Record<string, ParameterValue>;
  expression: Record<string, ParameterValue>;
  gesture: Record<string, ParameterValue>;
  mouth: Record<string, ParameterValue>;
}

export interface ParameterRange {
  min: number;
  max: number;
}

export interface MixerOptions {
  ranges?: Record<string, ParameterRange>;
}

function blend(current: number | undefined, next: ParameterValue): number {
  const weight = Math.max(0, Math.min(1, next.weight ?? 1));
  switch (next.blend ?? 'overwrite') {
    case 'add':
      return (current ?? 0) + next.value * weight;
    case 'multiply':
      return (current ?? 1) * (1 + (next.value - 1) * weight);
    case 'lerp':
      return (current ?? 0) + (next.value - (current ?? 0)) * weight;
    case 'overwrite':
      return next.value * weight + (current ?? 0) * (1 - weight);
  }
}

export class ParameterMixer {
  private readonly options: MixerOptions;

  constructor(options: MixerOptions = {}) {
    this.options = options;
  }

  mix(layers: ParameterLayers, capabilities: AvatarCapabilities): ParameterFrame {
    const supported = new Set(capabilities.parameters);
    const result: ParameterFrame = {};
    const orderedLayers = [
      layers.base,
      layers.expression,
      layers.gesture,
      layers.gaze,
      layers.mouth,
    ];

    for (const layer of orderedLayers) {
      for (const [parameter, value] of Object.entries(layer)) {
        if (!supported.has(parameter)) continue;
        result[parameter] = blend(result[parameter], value);
      }
    }

    for (const [parameter, value] of Object.entries(result)) {
      const range = this.options.ranges?.[parameter];
      if (range) result[parameter] = Math.max(range.min, Math.min(range.max, value));
    }
    return result;
  }
}
