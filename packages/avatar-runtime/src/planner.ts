import type {
  AvatarCapabilities,
  PerformancePlan,
  PerformanceSegment,
} from '../../contracts/src/index.ts';

export interface RuntimePolicy {
  defaultEmotionIntensity: number;
  maxActionsPerSegment: number;
}

export const DEFAULT_RUNTIME_POLICY: RuntimePolicy = {
  defaultEmotionIntensity: 0.5,
  maxActionsPerSegment: 1,
};

export interface AvatarPlanner {
  normalize(
    plan: PerformancePlan,
    capabilities: AvatarCapabilities,
    policy?: RuntimePolicy,
  ): PerformancePlan;
}

export class DefaultAvatarPlanner implements AvatarPlanner {
  normalize(
    plan: PerformancePlan,
    capabilities: AvatarCapabilities,
    policy: RuntimePolicy = DEFAULT_RUNTIME_POLICY,
  ): PerformancePlan {
    const ids = new Set<string>();
    const sequences = new Set<number>();

    const segments = plan.segments.map((segment): PerformanceSegment => {
      if (!segment.id || ids.has(segment.id)) {
        throw new Error(`Duplicate or empty segment id: ${segment.id}`);
      }
      if (!Number.isInteger(segment.sequence) || segment.sequence < 0 || sequences.has(segment.sequence)) {
        throw new Error(`Invalid or duplicate segment sequence: ${segment.sequence}`);
      }
      ids.add(segment.id);
      sequences.add(segment.sequence);

      const emotion = segment.emotion && capabilities.emotions.includes(segment.emotion.emotion)
        ? {
            ...segment.emotion,
            intensity: Math.max(0, Math.min(1, segment.emotion.intensity ?? policy.defaultEmotionIntensity)),
          }
        : undefined;
      const actions = segment.actions
        ?.filter(cue => capabilities.actions.includes(cue.action))
        .slice(0, policy.maxActionsPerSegment);

      const normalized: PerformanceSegment = {
        id: segment.id,
        sequence: segment.sequence,
        displayText: segment.displayText,
        speechText: segment.speechText,
      };
      if (emotion) normalized.emotion = emotion;
      if (actions?.length) normalized.actions = actions;
      return normalized;
    });

    return { ...plan, segments: segments.sort((a, b) => a.sequence - b.sequence) };
  }
}
