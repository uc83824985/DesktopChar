export interface HoldDragPoint {
  x: number;
  y: number;
}

export type HoldDragPhase = 'idle' | 'pending' | 'starting' | 'dragging';

export interface HoldDragResult<TTarget> {
  target: TTarget;
  moved: boolean;
  cancelled: boolean;
}

export interface HoldDragCallbacks<TTarget> {
  onPhaseChanged?(phase: HoldDragPhase): void;
  onHoldStarted(origin: Readonly<HoldDragPoint>, target: TTarget): void | Promise<void>;
  onDragMoved(point: Readonly<HoldDragPoint>, target: TTarget): void;
  onDragFinished(result: Readonly<HoldDragResult<TTarget>>): void | Promise<void>;
  onClicked(target: TTarget): void;
  onPendingCancelled?(target: TTarget): void;
  onError?(error: unknown, pointerId: number): void;
}

export interface HoldDragScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface HoldDragOptions<TTarget> {
  holdDelayMs: number;
  clickMovementThreshold?: number;
  dragMovementThreshold?: number;
  callbacks: HoldDragCallbacks<TTarget>;
  scheduler?: HoldDragScheduler;
}

interface Gesture<TTarget> {
  pointerId: number;
  target: TTarget;
  pressedAt: HoldDragPoint;
  latest: HoldDragPoint;
  dragOrigin?: HoldDragPoint;
  lastSent?: HoldDragPoint;
  timer: unknown;
  phase: Exclude<HoldDragPhase, 'idle'>;
  moved: boolean;
  released: boolean;
  cancelled: boolean;
}

const defaultScheduler: HoldDragScheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Distinguishes a click from an intentional press-and-hold drag. */
export class HoldDragController<TTarget> {
  readonly #callbacks: HoldDragCallbacks<TTarget>;
  readonly #scheduler: HoldDragScheduler;
  readonly #clickMovementThreshold: number;
  readonly #dragMovementThreshold: number;
  #holdDelayMs: number;
  #gesture: Gesture<TTarget> | undefined;

  constructor(options: HoldDragOptions<TTarget>) {
    this.#holdDelayMs = validDelay(options.holdDelayMs);
    this.#clickMovementThreshold = positive(options.clickMovementThreshold ?? 5, 'clickMovementThreshold');
    this.#dragMovementThreshold = positive(options.dragMovementThreshold ?? 1, 'dragMovementThreshold');
    this.#callbacks = options.callbacks;
    this.#scheduler = options.scheduler ?? defaultScheduler;
  }

  get phase(): HoldDragPhase {
    return this.#gesture?.phase ?? 'idle';
  }

  get hasGesture(): boolean {
    return this.#gesture !== undefined;
  }

  setHoldDelayMs(delayMs: number): void {
    this.#holdDelayMs = validDelay(delayMs);
  }

  begin(pointerId: number, target: TTarget, point: Readonly<HoldDragPoint>): boolean {
    if (this.#gesture) return false;
    const pressedAt = validPoint(point);
    const gesture: Gesture<TTarget> = {
      pointerId,
      target,
      pressedAt,
      latest: { ...pressedAt },
      timer: undefined,
      phase: 'pending',
      moved: false,
      released: false,
      cancelled: false,
    };
    gesture.timer = this.#scheduler.set(() => { void this.#activate(gesture); }, this.#holdDelayMs);
    this.#gesture = gesture;
    this.#callbacks.onPhaseChanged?.('pending');
    return true;
  }

  move(pointerId: number, point: Readonly<HoldDragPoint>): void {
    const gesture = this.#gesture;
    if (!gesture || gesture.pointerId !== pointerId || gesture.released) return;
    gesture.latest = validPoint(point);
    if (gesture.phase === 'dragging') this.#emitMove(gesture);
  }

  end(pointerId: number, point: Readonly<HoldDragPoint>, cancelled = false): boolean {
    const gesture = this.#gesture;
    if (!gesture || gesture.pointerId !== pointerId || gesture.released) return false;
    gesture.latest = validPoint(point);
    gesture.released = true;
    gesture.cancelled = cancelled;
    this.#scheduler.clear(gesture.timer);

    if (gesture.phase === 'pending') {
      this.#gesture = undefined;
      this.#callbacks.onPhaseChanged?.('idle');
      const click = !cancelled && distance(gesture.pressedAt, gesture.latest) < this.#clickMovementThreshold;
      if (click) this.#callbacks.onClicked(gesture.target);
      else this.#callbacks.onPendingCancelled?.(gesture.target);
    }
    else if (gesture.phase === 'dragging') {
      if (!cancelled) this.#emitMove(gesture);
      this.#finishDrag(gesture);
    }
    return true;
  }

  async #activate(gesture: Gesture<TTarget>): Promise<void> {
    if (this.#gesture !== gesture || gesture.released || gesture.phase !== 'pending') return;
    gesture.phase = 'starting';
    gesture.dragOrigin = { ...gesture.latest };
    this.#callbacks.onPhaseChanged?.('starting');
    try {
      await this.#callbacks.onHoldStarted(gesture.dragOrigin, gesture.target);
    }
    catch (error) {
      if (this.#gesture === gesture) {
        this.#gesture = undefined;
        this.#callbacks.onPhaseChanged?.('idle');
        this.#callbacks.onError?.(error, gesture.pointerId);
      }
      return;
    }
    if (this.#gesture !== gesture) return;
    gesture.phase = 'dragging';
    this.#callbacks.onPhaseChanged?.('dragging');
    if (gesture.released) this.#finishDrag(gesture);
    else this.#emitMove(gesture);
  }

  #emitMove(gesture: Gesture<TTarget>): void {
    const origin = gesture.dragOrigin;
    if (!origin || distance(origin, gesture.latest) < this.#dragMovementThreshold) return;
    if (gesture.lastSent && distance(gesture.lastSent, gesture.latest) === 0) return;
    gesture.moved = true;
    gesture.lastSent = { ...gesture.latest };
    this.#callbacks.onDragMoved(gesture.latest, gesture.target);
  }

  #finishDrag(gesture: Gesture<TTarget>): void {
    if (this.#gesture !== gesture) return;
    this.#gesture = undefined;
    this.#callbacks.onPhaseChanged?.('idle');
    try {
      const result = this.#callbacks.onDragFinished({
        target: gesture.target,
        moved: gesture.moved,
        cancelled: gesture.cancelled,
      });
      if (result instanceof Promise) void result.catch(error => this.#callbacks.onError?.(error, gesture.pointerId));
    }
    catch (error) {
      this.#callbacks.onError?.(error, gesture.pointerId);
    }
  }
}

function validDelay(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value >= 1_000) {
    throw new RangeError('holdDelayMs must be between 0 and 999 milliseconds');
  }
  return value;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

function validPoint(point: Readonly<HoldDragPoint>): HoldDragPoint {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new TypeError('Hold-drag point must be finite');
  return { x: point.x, y: point.y };
}

function distance(left: Readonly<HoldDragPoint>, right: Readonly<HoldDragPoint>): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}
