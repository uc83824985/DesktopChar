import type {
  AvatarCapabilities,
  LocalPerformanceSuggestion,
  PerformanceSegment,
} from '../../contracts/src/index.ts';
import type { RuntimePolicy } from './planner.ts';

export interface PerformanceSuggestionSlots {
  emotion: boolean;
  actions: boolean;
}

export function applyPerformanceSuggestion(
  segment: PerformanceSegment,
  suggestion: LocalPerformanceSuggestion,
  slots: PerformanceSuggestionSlots,
  capabilities: AvatarCapabilities,
  policy: RuntimePolicy,
): PerformanceSegment {
  const result = structuredClone(segment);
  if (
    slots.emotion
    && !result.emotion
    && suggestion.emotion
    && validUnit(suggestion.emotion.intensity)
    && validUnit(suggestion.emotion.confidence)
    && suggestion.emotion.confidence >= policy.minPerformanceConfidence
    && capabilities.emotions.includes(suggestion.emotion.emotion)
  ) {
    result.emotion = {
      emotion: suggestion.emotion.emotion,
      intensity: clampUnit(suggestion.emotion.intensity),
      atMs: 0,
    };
  }

  if (slots.actions && !result.actions?.length) {
    const actions = suggestion.actions
      .filter(candidate => (
        candidate.anchor === 'segment-start'
        && validUnit(candidate.confidence)
        && candidate.confidence >= policy.minPerformanceConfidence
        && capabilities.actions.includes(candidate.actionId)
      ))
      .slice(0, policy.maxActionsPerSegment)
      .map((candidate, index) => ({
        id: `performance:${segment.id}:${index}:${candidate.actionId}`,
        action: candidate.actionId,
        atMs: 0,
      }));
    if (actions.length) result.actions = actions;
  }
  return result;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function validUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}
