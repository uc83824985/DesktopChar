import type {
  ActionCue,
  EmotionCue,
  ExpressionCue,
  PerformanceSegment,
} from '../../contracts/src/index.ts';

export type TimelineCue =
  | { id: string; type: 'emotion'; atMs: number; payload: EmotionCue }
  | {
      id: string;
      type: 'expression';
      atMs: number;
      timingBasis: ExpressionTimingBasis;
      payload: ExpressionCue;
    }
  | { id: string; type: 'action'; atMs: number; payload: ActionCue };

export type ExpressionTimingBasis =
  | 'exact'
  | 'duration-ratio'
  | 'configured-rate'
  | 'immediate-fallback';

export interface PerformanceTimelineTiming {
  durationMs?: number;
  fallbackCharactersPerSecond?: number;
}

export class PerformanceTimeline {
  readonly segmentId: string;
  private cues: TimelineCue[];
  private readonly timing: PerformanceTimelineTiming;
  private emitted = new Set<string>();
  private paused = false;
  private cancelled = false;

  constructor(segment: PerformanceSegment, timing: PerformanceTimelineTiming = {}) {
    this.segmentId = segment.id;
    this.timing = normalizeTiming(timing);
    this.cues = timelineCues(segment, this.timing);
  }

  advance(positionMs: number): TimelineCue[] {
    if (this.paused || this.cancelled) return [];
    const due = this.cues.filter(cue => cue.atMs <= positionMs && !this.emitted.has(cue.id));
    for (const cue of due) this.emitted.add(cue.id);
    return due;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.cancelled) this.paused = false;
  }

  update(segment: PerformanceSegment): void {
    if (segment.id !== this.segmentId) {
      throw new Error(`Cannot update timeline ${this.segmentId} with segment ${segment.id}`);
    }
    if (!this.cancelled) this.cues = timelineCues(segment, this.timing);
  }

  cancel(): void {
    this.cancelled = true;
  }
}

function timelineCues(segment: PerformanceSegment, timing: PerformanceTimelineTiming): TimelineCue[] {
  const cues: TimelineCue[] = [];
  if (segment.emotion) {
    cues.push({
      id: `${segment.id}:emotion`,
      type: 'emotion',
      atMs: segment.emotion.atMs ?? 0,
      payload: segment.emotion,
    });
  }
  if (segment.expression) {
    cues.push(expressionTimelineCue(segment, segment.expression, 'explicit', timing));
  }
  for (const [index, expression] of (segment.expressionCues ?? []).entries()) {
    const cueId = expression.textAnchor
      ? `clause-${expression.textAnchor.clauseIndex}`
      : `inferred-${index}`;
    cues.push(expressionTimelineCue(segment, expression, cueId, timing));
  }
  for (const action of segment.actions ?? []) {
    cues.push({
      id: action.id,
      type: 'action',
      atMs: action.atMs ?? 0,
      payload: action,
    });
  }
  return cues.sort((a, b) => a.atMs - b.atMs);
}

function expressionTimelineCue(
  segment: PerformanceSegment,
  expression: ExpressionCue,
  id: string,
  timing: PerformanceTimelineTiming,
): TimelineCue {
  const resolved = resolveExpressionTiming(expression, timing);
  return {
    id: `${segment.id}:expression:${id}`,
    type: 'expression',
    atMs: resolved.atMs,
    timingBasis: resolved.basis,
    payload: expression,
  };
}

function resolveExpressionTiming(
  expression: ExpressionCue,
  timing: PerformanceTimelineTiming,
): { atMs: number; basis: ExpressionTimingBasis } {
  if (expression.atMs !== undefined) return { atMs: expression.atMs, basis: 'exact' };
  const anchor = expression.textAnchor;
  if (!anchor || anchor.totalCharacters <= 0) return { atMs: 0, basis: 'immediate-fallback' };
  const progress = Math.max(0, Math.min(1, anchor.startCharacter / anchor.totalCharacters));
  if (validDuration(timing.durationMs)) {
    return { atMs: Math.round(timing.durationMs * progress), basis: 'duration-ratio' };
  }
  if (validRate(timing.fallbackCharactersPerSecond)) {
    return {
      atMs: Math.round(anchor.startCharacter / timing.fallbackCharactersPerSecond * 1_000),
      basis: 'configured-rate',
    };
  }
  return { atMs: 0, basis: 'immediate-fallback' };
}

function validDuration(durationMs: number | undefined): durationMs is number {
  return durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0;
}

function validRate(rate: number | undefined): rate is number {
  return rate !== undefined && Number.isFinite(rate) && rate > 0;
}

function normalizeTiming(timing: PerformanceTimelineTiming): PerformanceTimelineTiming {
  if (timing.durationMs !== undefined && !validDuration(timing.durationMs)) {
    throw new RangeError('Timeline durationMs must be positive when provided');
  }
  if (
    timing.fallbackCharactersPerSecond !== undefined
    && !validRate(timing.fallbackCharactersPerSecond)
  ) {
    throw new RangeError('Timeline fallbackCharactersPerSecond must be positive when provided');
  }
  return { ...timing };
}
