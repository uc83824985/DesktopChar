import type {
  AvatarCapabilities,
  PerformancePlan,
  PerformanceSegment,
} from '../../contracts/src/index.ts';

export interface RuntimePolicy {
  defaultEmotionIntensity: number;
  maxActionsPerSegment: number;
  minPerformanceConfidence: number;
}

export const DEFAULT_RUNTIME_POLICY: RuntimePolicy = {
  defaultEmotionIntensity: 0.5,
  maxActionsPerSegment: 1,
  minPerformanceConfidence: 0.35,
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
      const expression = segment.expression && segment.expression.expressionKey.trim()
        ? {
            ...segment.expression,
            expressionKey: segment.expression.expressionKey.trim(),
            intensity: Math.max(
              0,
              Math.min(1, segment.expression.intensity ?? policy.defaultEmotionIntensity),
            ),
          }
        : undefined;
      const actions = segment.actions
        ?.filter(cue => capabilities.actions.includes(cue.action))
        .slice(0, policy.maxActionsPerSegment);
      validateSpeechBubble(segment);

      const normalized: PerformanceSegment = {
        id: segment.id,
        sequence: segment.sequence,
        displayText: segment.displayText,
        speechText: segment.speechText,
      };
      if (emotion) normalized.emotion = emotion;
      if (expression) normalized.expression = expression;
      if (actions?.length) normalized.actions = actions;
      if (segment.bubble) normalized.bubble = structuredClone(segment.bubble);
      return normalized;
    });

    return { ...plan, segments: segments.sort((a, b) => a.sequence - b.sequence) };
  }
}

function validateSpeechBubble(segment: PerformanceSegment): void {
  const bubble = segment.bubble;
  if (!bubble) return;
  if (!['stream', 'karaoke', 'complete'].includes(bubble.mode)) throw new Error(`Invalid speech bubble mode: ${bubble.mode}`);
  if (bubble.charactersPerSecond !== undefined && (!Number.isFinite(bubble.charactersPerSecond) || bubble.charactersPerSecond <= 0)) {
    throw new Error('Speech bubble charactersPerSecond must be positive');
  }
  if (bubble.dismissDelayMs !== undefined && (!Number.isFinite(bubble.dismissDelayMs) || bubble.dismissDelayMs < 0)) {
    throw new Error('Speech bubble dismissDelayMs must be non-negative');
  }
  if (!bubble.cues) return;
  let previousAtMs = -1;
  let combined = '';
  for (const cue of bubble.cues) {
    if (!cue.text || !Number.isFinite(cue.atMs) || cue.atMs < previousAtMs || cue.atMs < 0) throw new Error('Invalid speech bubble cue');
    if (cue.durationMs !== undefined && (!Number.isFinite(cue.durationMs) || cue.durationMs <= 0)) throw new Error('Invalid speech bubble cue duration');
    previousAtMs = cue.atMs;
    combined += cue.text;
  }
  if (combined !== segment.displayText) throw new Error('Speech bubble cues must concatenate to displayText');
}
