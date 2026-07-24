import {
  PERFORMANCE_PLANNING_V2_CONTRACT_VERSION,
  type AffectVector,
  type LocalPerformanceSuggestionV2,
  type PerformanceActionSuggestion,
  type PerformancePlanningRequestV2,
} from '../../contracts/src/index.ts';
import type { PerformanceInferencePortV2 } from './v2-port.ts';

interface SemanticRule {
  pattern: RegExp;
  tags: string[];
  affect: AffectVector;
}

const SEMANTIC_RULES: SemanticRule[] = [
  {
    pattern: /哈哈|开心|高兴|太好|真棒|谢谢|感谢|[!！]{2,}/u,
    tags: ['happy', 'warm', 'friendly', 'grateful', 'delighted'],
    affect: { valence: 0.9, arousal: 0.6, approval: 0.8, engagement: 0.85, certainty: 0.8 },
  },
  {
    pattern: /抱歉|难过|遗憾|可惜|伤心|担心/u,
    tags: ['sad', 'worried', 'concerned', 'apologetic'],
    affect: { valence: -0.75, arousal: 0.35, approval: 0, engagement: 0.75, certainty: 0.4 },
  },
  {
    pattern: /无语|嫌弃|不太认同|认真的吗/u,
    tags: ['displeased', 'dismissive', 'speechless', 'annoyed'],
    affect: { valence: -0.55, arousal: 0.35, approval: -0.85, engagement: 0.5, certainty: 0.8 },
  },
  {
    pattern: /竟然|居然|真的吗|怎么会|[?？]{2,}/u,
    tags: ['surprised', 'startled', 'alarmed', 'shocked'],
    affect: { valence: 0, arousal: 0.95, approval: 0, engagement: 1, certainty: 0.35 },
  },
  {
    pattern: /不好意思|害羞|别夸|脸红/u,
    tags: ['shy', 'embarrassed', 'uneasy', 'flustered'],
    affect: { valence: 0.35, arousal: 0.65, approval: 0.55, engagement: 0.75, certainty: 0.25 },
  },
  {
    pattern: /让我想想|考虑一下|也许|可能|分析/u,
    tags: ['thinking', 'calm', 'pause', 'reflective'],
    affect: { valence: 0.05, arousal: 0.1, approval: 0, engagement: 0.65, certainty: 0.35 },
  },
];

export class RuleBasedExpressionCatalogInference implements PerformanceInferencePortV2 {
  describe() {
    return {
      structuredOutput: 'json-object' as const,
      thinkingControl: 'unsupported' as const,
      streaming: false,
    };
  }

  async plan(
    request: PerformancePlanningRequestV2,
    signal: AbortSignal,
  ): Promise<LocalPerformanceSuggestionV2> {
    signal.throwIfAborted();
    const rule = SEMANTIC_RULES.find(candidate => candidate.pattern.test(request.text));
    const matching = rule
      ? request.expressions
          .map(descriptor => ({
            descriptor,
            matches: descriptor.semanticTags.filter(tag => rule.tags.includes(tag)).length,
          }))
          .filter(candidate => candidate.matches > 0)
          .sort((left, right) => (
            right.matches - left.matches
            || left.descriptor.expressionKey.localeCompare(right.descriptor.expressionKey)
          ))
          .slice(0, 3)
      : [];
    const actions = selectAction(request.text, request);
    return {
      contractVersion: PERFORMANCE_PLANNING_V2_CONTRACT_VERSION,
      requestId: request.requestId,
      segmentId: request.segmentId,
      segmentRevision: request.segmentRevision,
      catalogRevision: request.catalogRevision,
      source: 'rules',
      provider: 'deterministic-catalog-rules',
      ...(rule ? { affect: rule.affect } : {}),
      expressionCandidates: matching.length
        ? matching.map(({ descriptor, matches }, index) => ({
            expressionKey: descriptor.expressionKey,
            confidence: Math.max(0.45, 0.72 - index * 0.1 + Math.min(0.1, matches * 0.03)),
            intensity: 0.6,
          }))
        : [{
            expressionKey: request.defaultExpressionKey,
            confidence: 0.45,
            intensity: 0.25,
          }],
      actions: actions ? [actions] : [],
    };
  }
}

function selectAction(
  text: string,
  request: PerformancePlanningRequestV2,
): PerformanceActionSuggestion | undefined {
  const candidates = [
    ['greet', /你好|您好|早上好|晚上好|欢迎/u],
    ['shake', /不行|不要|不能|并不是|拒绝/u],
    ['nod', /是的|可以|当然|好的|没问题|同意/u],
  ] as const;
  for (const [actionId, pattern] of candidates) {
    const descriptor = request.actions.find(candidate => (
      candidate.actionId === actionId && candidate.allowedAnchors.includes('segment-start')
    ));
    if (descriptor && pattern.test(text)) {
      return { actionId, anchor: 'segment-start', confidence: 0.7 };
    }
  }
  return undefined;
}
