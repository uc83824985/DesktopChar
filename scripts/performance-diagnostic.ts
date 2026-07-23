import {
  PERFORMANCE_PLANNING_CONTRACT_VERSION,
  type PerformancePlanningRequest,
} from '../packages/contracts/src/index.ts';
import { OpenAiCompatiblePerformanceAdapter } from '../packages/performance-inference/src/index.ts';

const baseUrl = process.env.DESKTOP_CHAR_PERFORMANCE_BASE_URL ?? 'http://127.0.0.1:18090/v1';
const model = process.env.DESKTOP_CHAR_PERFORMANCE_MODEL;
const request: PerformancePlanningRequest = {
  contractVersion: PERFORMANCE_PLANNING_CONTRACT_VERSION,
  requestId: `diagnostic-${Date.now()}`,
  planId: 'diagnostic-plan',
  segmentId: 'diagnostic-segment',
  segmentRevision: 0,
  text: '你好，很高兴见到你！',
  persona: { id: 'mao', styleTags: ['friendly'] },
  scene: { id: 'desktop-default', modeTags: ['desktop', 'foreground'] },
  avatar: { state: 'thinking', currentEmotion: 'neutral' },
  emotions: ['neutral', 'happy'],
  actions: [{
    actionId: 'nod',
    label: '点头',
    tags: ['affirmation'],
    allowedAnchors: ['segment-start'],
  }],
};
const adapter = new OpenAiCompatiblePerformanceAdapter({
  provider: 'diagnostic-openai-compatible',
  baseUrl,
  ...(model ? { model } : {}),
  timeoutMs: 120_000,
  maxOutputTokens: 256,
  temperature: 0.1,
});
const startedAt = performance.now();
const suggestion = await adapter.plan(request, new AbortController().signal);

console.log(JSON.stringify({
  elapsedMs: Math.round(performance.now() - startedAt),
  suggestion,
}, null, 2));
