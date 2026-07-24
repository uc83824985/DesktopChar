import { readFile } from 'node:fs/promises';
import {
  PERFORMANCE_PLANNING_V2_CONTRACT_VERSION,
  type PerformancePlanningRequestV2,
} from '../packages/contracts/src/index.ts';
import { resolveExpression } from '../packages/avatar-runtime/src/index.ts';
import { parseCharacterConfig } from '../packages/config/src/index.ts';
import {
  AdaptedPerformanceInferenceV2,
  ExpressionCatalogPlanningAdapter,
  OpenAiCompatiblePerformanceTransport,
} from '../packages/performance-inference/src/index.ts';

const baseUrl = process.env.DESKTOP_CHAR_PERFORMANCE_BASE_URL ?? 'http://127.0.0.1:18090/v1';
const model = process.env.DESKTOP_CHAR_PERFORMANCE_MODEL;
const profileUrl = new URL(
  '../apps/desktop/public/models/Mao/DesktopChar.character.json',
  import.meta.url,
);
const profile = parseCharacterConfig(
  JSON.parse(await readFile(profileUrl, 'utf8')),
  'models/Mao/DesktopChar.character.json',
);
const catalog = profile.expressionCatalog;
if (!catalog) throw new Error('Performance v2 diagnostic requires an expressionCatalog');

const request: PerformancePlanningRequestV2 = {
  contractVersion: PERFORMANCE_PLANNING_V2_CONTRACT_VERSION,
  requestId: `diagnostic-${Date.now()}`,
  planId: 'diagnostic-plan',
  segmentId: 'diagnostic-segment',
  segmentRevision: 0,
  catalogRevision: catalog.revision,
  defaultExpressionKey: catalog.defaultExpressionKey,
  text: '你好，很高兴见到你！',
  persona: { id: profile.id, styleTags: ['friendly'] },
  scene: { id: 'desktop-default', modeTags: ['desktop', 'foreground'] },
  avatar: {
    state: 'thinking',
    currentExpressionKey: catalog.defaultExpressionKey,
    coarseEmotion: profile.defaultEmotion,
  },
  expressions: structuredClone(catalog.descriptors),
  actions: profile.allowedActions.map(actionId => ({
    actionId,
    label: actionId,
    tags: [],
    allowedAnchors: ['segment-start'],
  })),
};
const inference = new AdaptedPerformanceInferenceV2(
  new OpenAiCompatiblePerformanceTransport({
    provider: 'diagnostic-openai-compatible',
    baseUrl,
    ...(model ? { model } : {}),
    timeoutMs: 120_000,
  }),
  new ExpressionCatalogPlanningAdapter({
    maxOutputTokens: 256,
    temperature: 0.1,
  }),
);
const startedAt = performance.now();
const suggestion = await inference.plan(request, new AbortController().signal);
const resolved = resolveExpression({
  catalog,
  avatarState: request.avatar.state,
  resolutionId: request.segmentId,
  randomSeed: 0x44534348,
  nowMs: 0,
  candidates: suggestion.expressionCandidates,
  ...(suggestion.affect ? { affect: suggestion.affect } : {}),
  personaTags: request.persona.styleTags,
  sceneTags: request.scene.modeTags,
  currentExpressionKey: request.avatar.currentExpressionKey,
  history: [],
});

console.log(JSON.stringify({
  elapsedMs: Math.round(performance.now() - startedAt),
  suggestion,
  resolved,
  localBinding: catalog.bindings[resolved.expressionKey],
}, null, 2));
