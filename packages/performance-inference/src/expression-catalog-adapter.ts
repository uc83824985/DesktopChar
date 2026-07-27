import {
  PERFORMANCE_PLANNING_V2_CONTRACT_VERSION,
  type ExpressionCandidate,
  type LocalPerformanceSuggestionV2,
  type PerformancePlanningRequestV2,
} from '../../contracts/src/index.ts';
import type {
  PerformanceModelRequest,
  PerformanceModelResponse,
  PerformanceModelTransport,
} from './model-transport.ts';
import { PerformanceInferenceError } from './port.ts';
import {
  findRuleBasedTrigger,
  matchRuleBasedExpression,
  selectRuleBasedAction,
} from './rule-based-v2.ts';
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
        'You select a subtle character performance for one natural clause from an already-written reply.',
        'Return exactly one JSON object without Markdown or explanation.',
        'Use only expressionKey and actionId values present in the input catalogs.',
        'Never invent, translate, or paraphrase an ID.',
        'The result has exactly three root fields: expressionKey, trigger, and intensity.',
        'trigger is the shortest exact non-empty substring of text that most directly causes the expression.',
        'Copy trigger verbatim from text. Never paraphrase it and never return character offsets.',
        'intensity ranges from 0 to 1.',
        'Choose the expression whose semanticTags and prototypeTexts best match the strongest explicit affect in text.',
        'Do not preserve currentExpressionKey or defaultExpressionKey when an explicit affect phrase matches another expression.',
        'Use defaultExpressionKey only when text has no clear affect.',
        'trigger must contain only the decisive affect phrase, not the whole clause when a shorter exact phrase is sufficient.',
        'Do not return nested objects, arrays, affect, actions, confidence, anchors, or any field not listed above.',
        'Choose the expression for the current clause only; timing and transitions are handled by the runtime.',
      ].join('\n'),
      input: JSON.stringify({
        text: request.text,
        textAnchor: request.textAnchor,
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
    assertKnownKeys(
      root,
      ['expressionKey', 'trigger', 'intensity'],
      'performance suggestion v2',
    );
    let expressionCandidates = parseExpressionCandidates([{
      expressionKey: root.expressionKey,
      confidence: 0.85,
      intensity: root.intensity,
    }], request);
    const ruleMatch = matchRuleBasedExpression(request);
    let semanticGuardApplied = false;
    if (
      expressionCandidates[0]!.expressionKey === request.defaultExpressionKey
      && ruleMatch
      && ruleMatch.expressionCandidates[0]!.expressionKey !== request.defaultExpressionKey
    ) {
      expressionCandidates = ruleMatch.expressionCandidates;
      semanticGuardApplied = true;
    }
    const selectedDescriptor = request.expressions.find(expression => (
      expression.expressionKey === expressionCandidates[0]!.expressionKey
    ))!;
    const localTrigger = findRuleBasedTrigger(
      request.text,
      selectedDescriptor.semanticTags,
    );
    const expressionTrigger = parseExpressionTrigger(
      localTrigger ?? root.trigger,
      request,
    );
    const action = selectRuleBasedAction(request.text, request);
    return {
      contractVersion: PERFORMANCE_PLANNING_V2_CONTRACT_VERSION,
      requestId: request.requestId,
      segmentId: request.segmentId,
      segmentRevision: request.segmentRevision,
      catalogRevision: request.catalogRevision,
      textAnchor: structuredClone(request.textAnchor),
      expressionTrigger: expressionTrigger.text,
      expressionTextAnchor: expressionTrigger.anchor,
      source: 'model',
      provider: semanticGuardApplied
        ? `${response.provider}+semantic-guard`
        : response.provider,
      expressionCandidates,
      actions: action ? [action] : [],
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

function parseExpressionTrigger(
  value: unknown,
  request: PerformancePlanningRequestV2,
): { text: string; anchor: PerformancePlanningRequestV2['textAnchor'] } {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidResponse('expressionTrigger must be a non-empty exact substring of text');
  }
  const codeUnitStart = request.text.indexOf(value);
  if (codeUnitStart < 0) {
    throw invalidResponse('expressionTrigger must be copied exactly from text');
  }
  const localStart = Array.from(request.text.slice(0, codeUnitStart)).length;
  const triggerLength = Array.from(value).length;
  return {
    text: value,
    anchor: {
      clauseIndex: request.textAnchor.clauseIndex,
      clauseCount: request.textAnchor.clauseCount,
      startCharacter: request.textAnchor.startCharacter + localStart,
      endCharacter: request.textAnchor.startCharacter + localStart + triggerLength,
      totalCharacters: request.textAnchor.totalCharacters,
    },
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
  validateTextAnchor(request);
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

function validateTextAnchor(request: PerformancePlanningRequestV2): void {
  const anchor = request.textAnchor;
  if (
    !anchor
    || !Number.isInteger(anchor.clauseIndex)
    || !Number.isInteger(anchor.clauseCount)
    || !Number.isInteger(anchor.startCharacter)
    || !Number.isInteger(anchor.endCharacter)
    || !Number.isInteger(anchor.totalCharacters)
    || anchor.clauseIndex < 0
    || anchor.clauseCount <= 0
    || anchor.clauseIndex >= anchor.clauseCount
    || anchor.startCharacter < 0
    || anchor.endCharacter <= anchor.startCharacter
    || anchor.endCharacter > anchor.totalCharacters
  ) {
    throw invalidRequest('Performance textAnchor is invalid');
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
