import type {
  MessageExposure,
  RoutingContextPort,
  TaskSessionRouteCandidate,
  VisibleRoutingContextOptions,
  VisibleRoutingContextSnapshot,
} from './types.ts';

interface ExposureRecord extends MessageExposure {
  visibleOrder: number;
}

interface CandidateRecord extends TaskSessionRouteCandidate {
  activityOrder: number;
  sourceOrder: number;
}

export class VisibleRoutingContext implements RoutingContextPort {
  private options: VisibleRoutingContextOptions;
  private readonly exposures = new Map<string, ExposureRecord>();
  private readonly candidates = new Map<string, CandidateRecord>();
  private visibleContextRevision = 0;
  private visibleOrder = 0;

  constructor(options: VisibleRoutingContextOptions) {
    this.options = validateOptions(options);
  }

  configure(options: VisibleRoutingContextOptions): void {
    this.options = validateOptions(options);
  }

  replaceCandidates(values: readonly TaskSessionRouteCandidate[]): boolean {
    const next = validateCandidates(values);
    let changed = next.length !== this.candidates.size;
    const retained = new Set<string>();
    for (let index = 0; index < next.length; index++) {
      const candidate = next[index]!;
      retained.add(candidate.sessionId);
      const previous = this.candidates.get(candidate.sessionId);
      const record: CandidateRecord = {
        ...candidate,
        activityOrder: previous?.activityOrder ?? 0,
        sourceOrder: next.length - index,
      };
      if (!previous || !sameCandidate(previous, record)) changed = true;
      this.candidates.set(candidate.sessionId, record);
    }
    for (const sessionId of this.candidates.keys()) {
      if (retained.has(sessionId)) continue;
      this.candidates.delete(sessionId);
    }
    if (changed) this.visibleContextRevision += 1;
    return changed;
  }

  recordExposure(exposure: MessageExposure, relatedSessionId?: string): boolean {
    const normalized = validateExposure(exposure);
    const previous = this.exposures.get(normalized.messageId);
    if (previous && normalized.exposureRevision <= previous.exposureRevision) return false;
    if (
      previous
      && previous.phase === 'shown'
      && (normalized.phase !== 'shown' || !normalized.complete)
    ) {
      throw new TypeError('A shown exposure cannot return to showing');
    }
    this.visibleOrder += 1;
    this.exposures.set(normalized.messageId, {
      ...normalized,
      visibleOrder: this.visibleOrder,
    });
    if (this.exposures.size > this.options.maxTimelineEntries) {
      const oldest = [...this.exposures.values()]
        .sort((left, right) => left.visibleOrder - right.visibleOrder)[0];
      if (oldest) this.exposures.delete(oldest.messageId);
    }
    if (relatedSessionId !== undefined) this.touchCandidate(relatedSessionId, false);
    this.visibleContextRevision += 1;
    return true;
  }

  touchSession(sessionId: string): boolean {
    const normalized = nonEmptyText(sessionId, 'sessionId');
    const touched = this.touchCandidate(normalized, true);
    return touched;
  }

  freeze(): VisibleRoutingContextSnapshot {
    const exposures = [...this.exposures.values()]
      .sort((left, right) => left.visibleOrder - right.visibleOrder)
      .slice(-this.options.maxTimelineEntries)
      .map(({ visibleOrder: _visibleOrder, ...exposure }) => ({ ...exposure }));
    const candidates = [...this.candidates.values()]
      .sort((left, right) =>
        right.activityOrder - left.activityOrder
        || right.sourceOrder - left.sourceOrder
        || left.sessionId.localeCompare(right.sessionId))
      .slice(0, this.options.maxCandidates)
      .map(({ activityOrder: _activityOrder, sourceOrder: _sourceOrder, ...candidate }) => ({
        ...candidate,
      }));
    return {
      visibleContextRevision: this.visibleContextRevision,
      exposures,
      candidates,
      exposureCount: this.exposures.size,
      candidateCount: this.candidates.size,
    };
  }

  private touchCandidate(sessionId: string, incrementRevision: boolean): boolean {
    const candidate = this.candidates.get(sessionId);
    if (!candidate) return false;
    this.visibleOrder += 1;
    candidate.activityOrder = this.visibleOrder;
    if (incrementRevision) this.visibleContextRevision += 1;
    return true;
  }
}

function validateOptions(value: VisibleRoutingContextOptions): VisibleRoutingContextOptions {
  return {
    maxTimelineEntries: boundedInteger(
      value?.maxTimelineEntries,
      1,
      100,
      'maxTimelineEntries',
    ),
    maxCandidates: boundedInteger(value?.maxCandidates, 1, 50, 'maxCandidates'),
  };
}

function validateCandidates(
  values: readonly TaskSessionRouteCandidate[],
): TaskSessionRouteCandidate[] {
  if (!Array.isArray(values)) throw new TypeError('candidates must be an array');
  const seen = new Set<string>();
  return values.map((value, index) => {
    if (!record(value)) throw new TypeError(`candidate ${index} must be an object`);
    const sessionId = nonEmptyText(value.sessionId, `candidate ${index} sessionId`);
    if (seen.has(sessionId)) throw new TypeError(`candidate ${sessionId} is duplicated`);
    seen.add(sessionId);
    const status = value.status;
    if (
      typeof status !== 'string'
      || !['waiting-input', 'active', 'idle-unknown', 'unavailable'].includes(status)
    ) {
      throw new TypeError(`candidate ${sessionId} status is invalid`);
    }
    const title = optionalText(value.title);
    const summary = optionalText(value.summary);
    const lastVisibleEvent = optionalText(value.lastVisibleEvent);
    return {
      sessionId,
      status: status as TaskSessionRouteCandidate['status'],
      ...(title !== undefined ? { title } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(lastVisibleEvent !== undefined ? { lastVisibleEvent } : {}),
    };
  });
}

function validateExposure(value: MessageExposure): MessageExposure {
  if (!record(value)) throw new TypeError('exposure must be an object');
  const phase = value.phase;
  if (phase !== 'showing' && phase !== 'shown') throw new TypeError('exposure phase is invalid');
  if (typeof value.complete !== 'boolean') throw new TypeError('exposure complete must be boolean');
  if (phase === 'shown' && !value.complete) {
    throw new TypeError('shown exposure must be complete');
  }
  return {
    messageId: nonEmptyText(value.messageId, 'exposure messageId'),
    phase,
    visibleText: nonEmptyText(value.visibleText, 'exposure visibleText', true),
    complete: value.complete,
    exposureRevision: nonNegativeInteger(
      value.exposureRevision,
      'exposure exposureRevision',
    ),
  };
}

function sameCandidate(left: CandidateRecord, right: CandidateRecord): boolean {
  return left.sessionId === right.sessionId
    && left.status === right.status
    && left.title === right.title
    && left.summary === right.summary
    && left.lastVisibleEvent === right.lastVisibleEvent
    && left.sourceOrder === right.sourceOrder;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown, label: string, preserveWhitespace = false): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return preserveWhitespace ? value : value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}
