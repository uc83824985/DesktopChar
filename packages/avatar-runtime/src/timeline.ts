import type { ActionCue, EmotionCue, PerformanceSegment } from '../../contracts/src/index.ts';

export type TimelineCue =
  | { id: string; type: 'emotion'; atMs: number; payload: EmotionCue }
  | { id: string; type: 'action'; atMs: number; payload: ActionCue };

export class PerformanceTimeline {
  readonly segmentId: string;
  private readonly cues: TimelineCue[];
  private emitted = new Set<string>();
  private paused = false;
  private cancelled = false;

  constructor(segment: PerformanceSegment) {
    this.segmentId = segment.id;
    const cues: TimelineCue[] = [];
    if (segment.emotion) {
      cues.push({
        id: `${segment.id}:emotion`,
        type: 'emotion',
        atMs: segment.emotion.atMs ?? 0,
        payload: segment.emotion,
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
    this.cues = cues.sort((a, b) => a.atMs - b.atMs);
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

  cancel(): void {
    this.cancelled = true;
  }
}
