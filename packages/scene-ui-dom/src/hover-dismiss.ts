export type HoverDismissPhase = 'hidden' | 'visible' | 'closing';

export interface HoverDismissScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface HoverDismissOptions {
  dismissDelayMs?: number;
  fadeOutMs?: number;
  scheduler?: HoverDismissScheduler;
  onPhaseChanged?(phase: HoverDismissPhase): void;
}

const defaultScheduler: HoverDismissScheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Keeps an interaction surface visible while hovered and gives the user a
 * complete grace period after every leave. Re-entering during fade-out restores
 * the surface without destroying and recreating its DOM.
 */
export class HoverDismissController {
  readonly #dismissDelayMs: number;
  readonly #fadeOutMs: number;
  readonly #scheduler: HoverDismissScheduler;
  readonly #onPhaseChanged: ((phase: HoverDismissPhase) => void) | undefined;
  #phase: HoverDismissPhase = 'hidden';
  #inside = false;
  #dismissTimer: unknown;
  #fadeTimer: unknown;

  constructor(options: HoverDismissOptions = {}) {
    this.#dismissDelayMs = nonNegative(options.dismissDelayMs ?? 3_000, 'dismissDelayMs');
    this.#fadeOutMs = nonNegative(options.fadeOutMs ?? 120, 'fadeOutMs');
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#onPhaseChanged = options.onPhaseChanged;
  }

  get phase(): HoverDismissPhase {
    return this.#phase;
  }

  get inside(): boolean {
    return this.#inside;
  }

  show(): void {
    this.#clearTimers();
    this.#setPhase('visible');
    if (!this.#inside) this.#scheduleDismiss();
  }

  trackInside(inside: boolean): void {
    if (this.#inside === inside) return;
    this.#inside = inside;
    if (this.#phase === 'hidden') return;
    if (inside) {
      this.#clearTimers();
      this.#setPhase('visible');
    }
    else if (this.#phase === 'visible') {
      this.#scheduleDismiss();
    }
  }

  close(): void {
    this.#inside = false;
    this.#clearTimers();
    this.#setPhase('hidden');
  }

  dispose(): void {
    this.close();
  }

  #scheduleDismiss(): void {
    this.#clearDismissTimer();
    this.#dismissTimer = this.#scheduler.set(() => {
      this.#dismissTimer = undefined;
      if (this.#inside || this.#phase !== 'visible') return;
      this.#setPhase('closing');
      this.#fadeTimer = this.#scheduler.set(() => {
        this.#fadeTimer = undefined;
        if (this.#inside || this.#phase !== 'closing') return;
        this.#setPhase('hidden');
      }, this.#fadeOutMs);
    }, this.#dismissDelayMs);
  }

  #clearTimers(): void {
    this.#clearDismissTimer();
    if (this.#fadeTimer !== undefined) this.#scheduler.clear(this.#fadeTimer);
    this.#fadeTimer = undefined;
  }

  #clearDismissTimer(): void {
    if (this.#dismissTimer !== undefined) this.#scheduler.clear(this.#dismissTimer);
    this.#dismissTimer = undefined;
  }

  #setPhase(phase: HoverDismissPhase): void {
    if (this.#phase === phase) return;
    this.#phase = phase;
    this.#onPhaseChanged?.(phase);
  }
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be non-negative`);
  return value;
}
