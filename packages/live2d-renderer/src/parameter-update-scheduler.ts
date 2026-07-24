export const PARAMETER_UPDATE_ORDER = {
  EYE_BLINK: 200,
  EXPRESSION: 300,
  GAZE_FOCUS: 400,
  BREATH: 500,
  PHYSICS: 600,
  LIP_SYNC: 700,
  POSE: 800,
  RUNTIME_FINAL: 900,
} as const;

export interface ParameterUpdater<Context> {
  readonly id: string;
  readonly executionOrder: number;
  update(context: Context): void;
}

export interface ParameterUpdaterDescriptor {
  id: string;
  executionOrder: number;
}

interface RegisteredUpdater<Context> {
  updater: ParameterUpdater<Context>;
  sequence: number;
  enabled: boolean;
}

/**
 * Stable, frame-snapshot scheduler based on Cubism 5-r.5's ICubismUpdater
 * ordering model. Concrete Live2D SDK objects stay behind renderer adapters.
 */
export class ParameterUpdateScheduler<Context> {
  private readonly entries = new Map<string, RegisteredUpdater<Context>>();
  private ordered: RegisteredUpdater<Context>[] = [];
  private nextSequence = 0;
  private dirty = false;

  register(updater: ParameterUpdater<Context>): () => void {
    validateUpdater(updater);
    if (this.entries.has(updater.id)) {
      throw new Error(`Parameter updater "${updater.id}" is already registered`);
    }
    this.entries.set(updater.id, { updater, sequence: this.nextSequence++, enabled: true });
    this.dirty = true;
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      this.remove(updater.id);
    };
  }

  remove(id: string): boolean {
    const removed = this.entries.delete(id);
    if (removed) this.dirty = true;
    return removed;
  }

  setExecutionOrder(id: string, executionOrder: number): void {
    validateExecutionOrder(executionOrder);
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Parameter updater "${id}" is not registered`);
    if (entry.updater.executionOrder === executionOrder) return;
    entry.updater = { ...entry.updater, executionOrder };
    this.dirty = true;
  }

  setEnabled(id: string, enabled: boolean): void {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Parameter updater "${id}" is not registered`);
    entry.enabled = enabled;
  }

  isEnabled(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Parameter updater "${id}" is not registered`);
    return entry.enabled;
  }

  run(context: Context): void {
    this.sortIfNeeded();
    // Mutations requested by an updater take effect on the next frame.
    const frame = this.ordered.filter(entry => entry.enabled);
    for (const entry of frame) entry.updater.update(context);
  }

  list(): ParameterUpdaterDescriptor[] {
    this.sortIfNeeded();
    return this.ordered.map(({ updater }) => ({
      id: updater.id,
      executionOrder: updater.executionOrder,
    }));
  }

  clear(): void {
    this.entries.clear();
    this.ordered = [];
    this.dirty = false;
  }

  private sortIfNeeded(): void {
    if (!this.dirty) return;
    this.ordered = [...this.entries.values()].sort((left, right) => (
      left.updater.executionOrder - right.updater.executionOrder
      || left.sequence - right.sequence
    ));
    this.dirty = false;
  }
}

function validateUpdater<Context>(updater: ParameterUpdater<Context>): void {
  if (!updater || typeof updater.id !== 'string' || updater.id.trim() !== updater.id || !updater.id) {
    throw new TypeError('Parameter updater id must be a non-empty trimmed string');
  }
  if (typeof updater.update !== 'function') {
    throw new TypeError(`Parameter updater "${updater.id}" must provide update()`);
  }
  validateExecutionOrder(updater.executionOrder);
}

function validateExecutionOrder(executionOrder: number): void {
  if (!Number.isSafeInteger(executionOrder) || executionOrder < 0) {
    throw new RangeError('Parameter updater executionOrder must be a non-negative safe integer');
  }
}
