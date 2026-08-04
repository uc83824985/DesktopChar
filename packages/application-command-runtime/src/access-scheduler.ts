import type {
  ApplicationAccessClaim,
  ApplicationAccessSchedulerSnapshot,
} from './types.ts';
import { abortReason, normalizeAccessClaims } from './validation.ts';

interface ScheduledAccess<T> {
  id: number;
  claims: ApplicationAccessClaim[];
  operation(signal: AbortSignal): Promise<T> | T;
  signal: AbortSignal;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
  onAbort(): void;
}

interface ActiveAccess {
  id: number;
  claims: ApplicationAccessClaim[];
}

/**
 * Fair read/write scheduling over application-owned resource keys. A queued
 * writer cannot be overtaken by a later reader for the same resource, while
 * unrelated resources remain independently executable.
 */
export class ApplicationAccessScheduler {
  readonly #pending: ScheduledAccess<unknown>[] = [];
  readonly #active = new Map<number, ActiveAccess>();
  #sequence = 0;

  schedule<T>(
    claims: readonly ApplicationAccessClaim[],
    operation: (signal: AbortSignal) => Promise<T> | T,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const normalizedClaims = normalizeAccessClaims(claims);
    const signal = options.signal ?? new AbortController().signal;
    if (signal.aborted) return Promise.reject(abortReason(signal));

    return new Promise<T>((resolve, reject) => {
      const scheduled: ScheduledAccess<T> = {
        id: ++this.#sequence,
        claims: normalizedClaims,
        operation,
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.#pending.indexOf(scheduled as ScheduledAccess<unknown>);
          if (index < 0) return;
          this.#pending.splice(index, 1);
          reject(abortReason(signal));
          this.#drain();
        },
      };
      signal.addEventListener('abort', scheduled.onAbort, { once: true });
      this.#pending.push(scheduled as ScheduledAccess<unknown>);
      this.#drain();
    });
  }

  getSnapshot(): ApplicationAccessSchedulerSnapshot {
    return {
      queuedCount: this.#pending.length,
      activeCount: this.#active.size,
      activeClaims: [...this.#active.values()].map(item =>
        item.claims.map(claim => ({ ...claim }))),
    };
  }

  #drain(): void {
    const earlierBlocked: ApplicationAccessClaim[][] = [];
    for (let index = 0; index < this.#pending.length;) {
      const scheduled = this.#pending[index]!;
      const activeConflict = [...this.#active.values()].some(active =>
        accessClaimsConflict(active.claims, scheduled.claims));
      const earlierConflict = earlierBlocked.some(claims =>
        accessClaimsConflict(claims, scheduled.claims));
      if (activeConflict || earlierConflict) {
        earlierBlocked.push(scheduled.claims);
        index++;
        continue;
      }
      this.#pending.splice(index, 1);
      this.#start(scheduled);
    }
  }

  #start(scheduled: ScheduledAccess<unknown>): void {
    scheduled.signal.removeEventListener('abort', scheduled.onAbort);
    if (scheduled.signal.aborted) {
      scheduled.reject(abortReason(scheduled.signal));
      queueMicrotask(() => this.#drain());
      return;
    }
    this.#active.set(scheduled.id, {
      id: scheduled.id,
      claims: scheduled.claims,
    });
    Promise.resolve()
      .then(() => scheduled.operation(scheduled.signal))
      .then(scheduled.resolve, scheduled.reject)
      .finally(() => {
        this.#active.delete(scheduled.id);
        this.#drain();
      });
  }
}

export function accessClaimsConflict(
  left: readonly ApplicationAccessClaim[],
  right: readonly ApplicationAccessClaim[],
): boolean {
  for (const leftClaim of left) {
    for (const rightClaim of right) {
      if (leftClaim.resource !== rightClaim.resource) continue;
      if (leftClaim.mode === 'write' || rightClaim.mode === 'write') return true;
    }
  }
  return false;
}
