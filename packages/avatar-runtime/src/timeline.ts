import type {
  ActionCue,
  EmotionCue,
  ExpressionCue,
  PerformanceSegment,
} from '../../contracts/src/index.ts';

export type TimelineCue =
  | { id: string; type: 'emotion'; atMs: number; payload: EmotionCue }
  | { id: string; type: 'expression'; atMs: number; payload: ExpressionCue }
  | { id: string; type: 'action'; atMs: number; payload: ActionCue };

export class PerformanceTimeline {
  readonly segmentId: string;
  private cues: TimelineCue[];
  private emitted = new Set<string>();
  private paused = false;
  private cancelled = false;

  constructor(segment: PerformanceSegment) {
    this.segmentId = segment.id;
    this.cues = timelineCues(segment);
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
    if (!this.cancelled) this.cues = timelineCues(segment);
  }

  cancel(): void {
    this.cancelled = true;
  }
}

function timelineCues(segment: PerformanceSegment): TimelineCue[] {
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
    cues.push({
      id: `${segment.id}:expression`,
      type: 'expression',
      atMs: segment.expression.atMs ?? 0,
      payload: segment.expression,
    });
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
