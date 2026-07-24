import {
  PERFORMANCE_PLANNING_V2_CONTRACT_VERSION,
  type AffectVector,
  type ExpressionCandidate,
  type LocalPerformanceSuggestionV2,
  type PerformanceActionDescriptor,
  type PerformanceActionSuggestion,
  type PerformancePlanningRequestV2,
} from '../../contracts/src/index.ts';
import type {
  PerformanceModelRequest,
  PerformanceModelResponse,
  PerformanceModelTransport,
} from './model-transport.ts';
import { PerformanceInferenceError } from './port.ts';
import type { PerformanceInferencePortV2 } from './v2-port.ts';

export interface ExpressionCatalogAdapterConfig {
  maxOutputTokens: number;
  temperature: number;
}

/**
 * Domain adapter between a character-independent text model and the v2
 * expression-catalog contract. It never receives renderer bindings.
 */
export interface PerformancePlanningAdapterV2 {
  prepare(request: PerformancePlanningRequestV2): PerformanceModelRequest;
  parse(
    response: PerformanceModelResponse,
    request: PerformancePlanningRequestV2,
  ): LocalPerformanceSuggestionV2;
}

export class ExpressionCatalogPlanningAdapter implements PerformancePlanningAdapterV2 {
  private readonly config: ExpressionCatalogAdapterConfig;

  constructor(config: ExpressionCatalogAdapterConfig) {
    if (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens <= 0) {
      throw new TypeError('Performance Adapter maxOutputTokens must be a positive integer');
    }
    if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) {
      throw new TypeError('Performance Adapter temperature must be from 0 to 2');
    }
    this.config = { ...config };
  }

  prepare(request: PerformancePlanningRequestV2): PerformanceModelRequest {
    validateRequest(request);
    return {
      instructions: [
        'You select a subtle character performance for one already-written reply segment.',
        'Return exactly one JSON object without Markdown or explanation.',
        'Use only expressionKey and actionId values present in the input catalogs.',
        'Never invent, translate, or paraphrase an ID. Empty candidates/actions are valid.',
        'The result has exactly three fields: affect, expressionCandidates, actions.',
        'affect is null or a full object with valence, arousal, approval, engagement, certainty.',
        'valence and approval range from -1 to 1; other affect values range from 0 to 1.',
        'expressionCandidates contains at most three unique objects with expressionKey, confidence, intensity.',
        'actions contains at most two unique objects with actionId, confidence, anchor, and optional clauseIndex.',
        'confidence and intensity range from 0 to 1. Prefer no action over a weak repetitive action.',
      ].join('\n'),
      input: JSON.stringify({
        text: request.text,
        persona: request.persona,
        scene: request.scene,
        avatar: request.avatar,
        defaultExpressionKey: request.defaultExpressionKey,
        expressionCatalog: request.expressions.map(expression => ({
          expressionKey: expression.expressionKey,
          label: expression.label,
          semanticTags: expression.semanticTags,
          prototypeTexts: expression.prototypeTexts,
          ...(expression.affectPrototype ? { affectPrototype: expression.affectPrototype } : {}),
          compatibleAvatarStates: expression.compatibleAvatarStates,
        })),
        actionCatalog: request.actions.map(action => ({
          actionId: action.actionId,
          label: action.label,
          tags: action.tags,
          allowedAnchors: action.allowedAnchors,
        })),
      }),
      maxOutputTokens: this.config.maxOutputTokens,
      temperature: this.config.temperature,
    };
  }

  parse(
    response: PerformanceModelResponse,
    request: PerformancePlanningRequestV2,
  ): LocalPerformanceSuggestionV2 {
    validateRequest(request);
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonObject(response.text));
    }
    catch (cause) {
      throw invalidResponse(
        `Performance Provider did not return valid JSON: ${JSON.stringify(response.text.trim().slice(0, 400))}`,
        cause,
      );
    }
    const root = record(parsed, 'performance suggestion v2');
    assertKnownKeys(root, ['affect', 'expressionCandidates', 'actions'], 'performance suggestion v2');
    const affect = parseAffect(root.affect);
    const expressionCandidates = parseExpressionCandidates(root.expressionCandidates, request);
    const actions = parseActions(root.actions, request.actions);
    return {
      contractVersion: PERFORMANCE_PLANNING_V2_CONTRACT_VERSION,
      requestId: request.requestId,
      segmentId: request.segmentId,
      segmentRevision: request.segmentRevision,
      catalogRevision: request.catalogRevision,
      source: 'model',
      provider: response.provider,
      ...(affect ? { affect } : {}),
      expressionCandidates,
      actions,
    };
  }
}

export class AdaptedPerformanceInferenceV2 implements PerformanceInferencePortV2 {
  private readonly transport: PerformanceModelTransport;
  private readonly adapter: PerformancePlanningAdapterV2;

  constructor(transport: PerformanceModelTransport, adapter: PerformancePlanningAdapterV2) {
    this.transport = transport;
    this.adapter = adapter;
  }

  describe() {
    return this.transport.describe();
  }

  async plan(
    request: PerformancePlanningRequestV2,
    signal: AbortSignal,
  ): Promise<LocalPerformanceSuggestionV2> {
    const modelRequest = this.adapter.prepare(request);
    const response = await this.transport.complete(modelRequest, signal);
    return this.adapter.parse(response, request);
  }
}

function parseAffect(value: unknown): AffectVector | undefined {
  if (value === null || value === undefined) return undefined;
  const affect = record(value, 'performance suggestion affect');
  assertKnownKeys(
    affect,
    ['valence', 'arousal', 'approval', 'engagement', 'certainty'],
    'performance suggestion affect',
  );
  return {
    valence: rangedNumber(affect.valence, -1, 1, 'affect valence'),
    arousal: rangedNumber(affect.arousal, 0, 1, 'affect arousal'),
    approval: rangedNumber(affect.approval, -1, 1, 'affect approval'),
    engagement: rangedNumber(affect.engagement, 0, 1, 'affect engagement'),
    certainty: rangedNumber(affect.certainty, 0, 1, 'affect certainty'),
  };
}

function parseExpressionCandidates(
  value: unknown,
  request: PerformancePlanningRequestV2,
): ExpressionCandidate[] {
  if (!Array.isArray(value)) throw invalidResponse('expressionCandidates must be an array');
  if (value.length > Math.min(3, request.expressions.length)) {
    throw invalidResponse('Performance suggestion contains too many expression candidates');
  }
  const available = new Set(request.expressions.map(expression => expression.expressionKey));
  const seen = new Set<string>();
  return value.map((item, index) => {
    const candidate = record(item, `expressionCandidates[${index}]`);
    assertKnownKeys(
      candidate,
      ['expressionKey', 'confidence', 'intensity'],
      `expressionCandidates[${index}]`,
    );
    if (
      typeof candidate.expressionKey !== 'string'
      || !available.has(candidate.expressionKey)
      || seen.has(candidate.expressionKey)
    ) {
      throw invalidResponse('Expression candidate IDs must be available and unique');
    }
    seen.add(candidate.expressionKey);
    return {
      expressionKey: candidate.expressionKey,
      confidence: unitNumber(candidate.confidence, `expressionCandidates[${index}] confidence`),
      intensity: unitNumber(candidate.intensity, `expressionCandidates[${index}] intensity`),
    };
  });
}

function parseActions(
  value: unknown,
  descriptors: PerformanceActionDescriptor[],
): PerformanceActionSuggestion[] {
  if (!Array.isArray(value)) throw invalidResponse('Performance suggestion actions must be an array');
  if (value.length > Math.min(2, descriptors.length)) {
    throw invalidResponse('Performance suggestion contains too many actions');
  }
  const descriptorById = new Map(descriptors.map(descriptor => [descriptor.actionId, descriptor]));
  const seen = new Set<string>();
  return value.map((item, index): PerformanceActionSuggestion => {
    const action = record(item, `performance suggestion actions[${index}]`);
    assertKnownKeys(
      action,
      ['actionId', 'confidence', 'anchor', 'clauseIndex'],
      `performance suggestion actions[${index}]`,
    );
    if (typeof action.actionId !== 'string' || seen.has(action.actionId)) {
      throw invalidResponse('Suggested action IDs must be available and unique');
    }
    const descriptor = descriptorById.get(action.actionId as never);
    if (!descriptor) throw invalidResponse(`Suggested action is not available: ${String(action.actionId)}`);
    if (
      typeof action.anchor !== 'string'
      || !descriptor.allowedAnchors.includes(action.anchor as never)
    ) {
      throw invalidResponse(`Suggested action anchor is not allowed: ${String(action.anchor)}`);
    }
    seen.add(action.actionId);
    const suggestion: PerformanceActionSuggestion = {
      actionId: descriptor.actionId,
      confidence: unitNumber(action.confidence, `actions[${index}] confidence`),
      anchor: action.anchor as PerformanceActionSuggestion['anchor'],
    };
    if (suggestion.anchor === 'after-clause') {
      if (!Number.isInteger(action.clauseIndex) || (action.clauseIndex as number) < 0) {
        throw invalidResponse(`actions[${index}] clauseIndex must be a non-negative integer`);
      }
      suggestion.clauseIndex = action.clauseIndex as number;
    }
    else if (action.clauseIndex !== undefined) {
      throw invalidResponse(`actions[${index}] clauseIndex is only valid with after-clause`);
    }
    return suggestion;
  });
}

function validateRequest(request: PerformancePlanningRequestV2): void {
  if (request.contractVersion !== PERFORMANCE_PLANNING_V2_CONTRACT_VERSION) {
    throw new PerformanceInferenceError(
      'performance-contract-mismatch',
      'Unsupported performance planning v2 contract',
      { recoverable: false },
    );
  }
  if (!request.requestId || !request.planId || !request.segmentId || !request.text.trim()) {
    throw invalidRequest('Performance request identity and text are required');
  }
  if (!Number.isInteger(request.segmentRevision) || request.segmentRevision < 0) {
    throw invalidRequest('Performance segmentRevision must be a non-negative integer');
  }
  if (!Number.isInteger(request.catalogRevision) || request.catalogRevision < 0) {
    throw invalidRequest('Performance catalogRevision must be a non-negative integer');
  }
  if (!Array.isArray(request.expressions) || !request.expressions.length) {
    throw invalidRequest('Performance expression catalog must not be empty');
  }
  const expressionKeys = new Set<string>();
  for (const descriptor of request.expressions) {
    if (!descriptor.expressionKey || expressionKeys.has(descriptor.expressionKey)) {
      throw invalidRequest('Performance expression catalog IDs must be non-empty and unique');
    }
    expressionKeys.add(descriptor.expressionKey);
  }
  if (!expressionKeys.has(request.defaultExpressionKey)) {
    throw invalidRequest('Performance default expression is not in the catalog');
  }
  const actionIds = new Set<string>();
  for (const action of request.actions) {
    if (
      !action.actionId
      || actionIds.has(action.actionId)
      || !action.allowedAnchors.length
    ) {
      throw invalidRequest('Performance action capabilities must have unique IDs and non-empty anchors');
    }
    actionIds.add(action.actionId);
  }
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  const withoutFence = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
    : trimmed;
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end < start) throw invalidResponse('Performance response has no JSON object');
  return withoutFence.slice(start, end + 1);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidResponse(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).filter(key => !known.has(key));
  if (unknown.length) throw invalidResponse(`${label} contains unknown fields: ${unknown.join(', ')}`);
}

function unitNumber(value: unknown, label: string): number {
  return rangedNumber(value, 0, 1, label);
}

function rangedNumber(value: unknown, minimum: number, maximum: number, label: string): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) {
    throw invalidResponse(`${label} must be from ${minimum} to ${maximum}`);
  }
  return value;
}

function invalidResponse(message: string, cause?: unknown): PerformanceInferenceError {
  return new PerformanceInferenceError(
    'performance-invalid-response',
    message,
    cause === undefined ? {} : { cause },
  );
}

function invalidRequest(message: string): PerformanceInferenceError {
  return new PerformanceInferenceError(
    'performance-invalid-request',
    message,
    { recoverable: false },
  );
}
