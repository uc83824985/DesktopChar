import {
  PERFORMANCE_PLANNING_CONTRACT_VERSION,
  type AvatarAction,
  type Emotion,
  type LocalPerformanceSuggestion,
  type PerformanceActionSuggestion,
  type PerformanceInferenceCapabilities,
  type PerformancePlanningRequest,
} from '../../contracts/src/index.ts';
import type { PerformanceInferencePort } from './port.ts';

export class RuleBasedPerformanceInference implements PerformanceInferencePort {
  describe(): PerformanceInferenceCapabilities {
    return {
      structuredOutput: 'json-object',
      thinkingControl: 'unsupported',
      streaming: false,
    };
  }

  async plan(
    request: PerformancePlanningRequest,
    signal: AbortSignal,
  ): Promise<LocalPerformanceSuggestion> {
    signal.throwIfAborted();
    const emotion = selectEmotion(request.text, request.emotions);
    const action = selectAction(request.text, request);
    return {
      contractVersion: PERFORMANCE_PLANNING_CONTRACT_VERSION,
      requestId: request.requestId,
      segmentId: request.segmentId,
      segmentRevision: request.segmentRevision,
      source: 'rules',
      provider: 'deterministic-rules',
      ...(emotion ? {
        emotion: {
          emotion,
          intensity: emotion === 'neutral' ? 0.25 : 0.6,
          confidence: emotion === 'neutral' ? 0.45 : 0.72,
          anchor: 'segment-start',
        },
      } : {}),
      actions: action ? [action] : [],
    };
  }
}

function selectEmotion(text: string, available: Emotion[]): Emotion | undefined {
  const rules: Array<[Emotion, RegExp]> = [
    ['happy', /哈哈|开心|高兴|太好|真棒|谢谢|感谢|[!！]{2,}/u],
    ['sad', /抱歉|难过|遗憾|可惜|伤心/u],
    ['angry', /生气|讨厌|愤怒|不能接受/u],
    ['surprised', /竟然|居然|真的吗|怎么会|[?？]{2,}/u],
    ['thinking', /让我想想|考虑一下|也许|可能|分析/u],
  ];
  for (const [emotion, pattern] of rules) {
    if (available.includes(emotion) && pattern.test(text)) return emotion;
  }
  return available.includes('neutral') ? 'neutral' : available[0];
}

function selectAction(
  text: string,
  request: PerformancePlanningRequest,
): PerformanceActionSuggestion | undefined {
  const candidates: Array<[AvatarAction, RegExp]> = [
    ['greet', /你好|您好|早上好|晚上好|欢迎/u],
    ['shake', /不行|不要|不能|并不是|拒绝/u],
    ['nod', /是的|可以|当然|好的|没问题|同意/u],
  ];
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
