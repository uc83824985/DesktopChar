import type { AvatarCapabilities, MotionCommand, MotionResult, ParameterFrame } from '../../contracts/src/index.ts';
import type { Live2DCoreModel, Live2DCoreModelPort, Live2DModelSource, Live2DRendererPort } from './model-port.ts';

export class Live2DRenderer implements Live2DRendererPort {
  private model: Live2DCoreModel | null = null;
  private loadGeneration = 0;
  private readonly core: Live2DCoreModelPort;

  constructor(core: Live2DCoreModelPort) { this.core = core; }

  async load(source: Live2DModelSource): Promise<AvatarCapabilities> {
    const generation = ++this.loadGeneration;
    const candidate = await this.core.load(source);
    if (generation !== this.loadGeneration) {
      await candidate.dispose();
      throw new Error(`Model load superseded: ${source.id}`);
    }
    const previous = this.model;
    this.model = candidate;
    await previous?.dispose();
    return capabilitiesOf(candidate);
  }

  applyFrame(frame: ParameterFrame): void {
    const model = this.requireModel();
    const parameters = new Map(model.descriptor.parameters.map(parameter => [parameter.id, parameter]));
    for (const [publicId, value] of Object.entries(frame)) {
      const id = model.descriptor.aliases?.[publicId] ?? publicId;
      const parameter = parameters.get(id);
      if (parameter) model.setParameter(id, clamp(value, parameter.minimum, parameter.maximum));
    }
  }

  async playMotion(command: MotionCommand): Promise<MotionResult> {
    const group = this.requireModel().descriptor.actions[command.action];
    if (!group) return { actionId: command.actionId, completed: false };
    await this.requireModel().playMotion(group);
    return { actionId: command.actionId, completed: true };
  }

  hitTest(x: number, y: number): string[] {
    const model = this.requireModel();
    return model.descriptor.hitAreas.length ? model.hitTest(x, y) : [];
  }

  resize(width: number, height: number): void {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new RangeError('Renderer size must be positive and finite');
    }
    this.requireModel().resize(width, height);
  }

  async unload(): Promise<void> {
    ++this.loadGeneration;
    const model = this.model;
    this.model = null;
    await model?.dispose();
  }

  private requireModel(): Live2DCoreModel {
    if (!this.model) throw new Error('Live2D model is not loaded');
    return this.model;
  }
}

function capabilitiesOf(model: Live2DCoreModel): AvatarCapabilities {
  const ids = new Set(model.descriptor.parameters.map(parameter => parameter.id));
  const aliases = model.descriptor.aliases ?? {};
  const supports = (id: string): boolean => ids.has(aliases[id] ?? id);
  return {
    emotions: Object.keys(model.descriptor.emotions) as AvatarCapabilities['emotions'],
    actions: Object.keys(model.descriptor.actions) as AvatarCapabilities['actions'],
    parameters: [...ids, ...Object.keys(aliases)],
    supportsMouthForm: supports('ParamMouthForm'),
    supportsGaze: supports('ParamAngleX') && supports('ParamAngleY'),
    supportsHitTest: model.descriptor.hitAreas.length > 0,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, value));
}
