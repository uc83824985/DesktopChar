import type { CoreModelDescriptor, Live2DCoreModel, Live2DCoreModelPort, Live2DModelSource } from './model-port.ts';

export class FakeLive2DModel implements Live2DCoreModel {
  readonly descriptor: CoreModelDescriptor;
  readonly values = new Map<string, number>();
  readonly motions: string[] = [];
  size = { width: 0, height: 0 };
  disposed = false;

  constructor(descriptor: CoreModelDescriptor) { this.descriptor = descriptor; }
  setParameter(id: string, value: number): void { this.values.set(id, value); }
  async playMotion(group: string): Promise<void> { this.motions.push(group); }
  hitTest(): string[] { return [...this.descriptor.hitAreas]; }
  resize(width: number, height: number): void { this.size = { width, height }; }
  async dispose(): Promise<void> { this.disposed = true; }
}

export class FakeLive2DCore implements Live2DCoreModelPort {
  readonly models = new Map<string, FakeLive2DModel>();
  private readonly descriptors: Record<string, CoreModelDescriptor>;
  constructor(descriptors: Record<string, CoreModelDescriptor>) { this.descriptors = descriptors; }
  async load(source: Live2DModelSource): Promise<FakeLive2DModel> {
    const descriptor = this.descriptors[source.id];
    if (!descriptor) throw new Error(`Unknown fake model: ${source.id}`);
    const model = new FakeLive2DModel(descriptor);
    this.models.set(source.id, model);
    return model;
  }
}
