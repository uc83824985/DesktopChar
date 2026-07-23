import {
  PERFORMANCE_PLANNING_CONTRACT_VERSION,
  type LocalPerformanceSuggestion,
  type PerformanceActionDescriptor,
  type PerformanceActionSuggestion,
  type PerformanceEmotionSuggestion,
  type PerformanceInferenceCapabilities,
  type PerformancePlanningRequest,
} from '../../contracts/src/index.ts';
import type { PerformanceInferencePort } from './port.ts';
import { PerformanceInferenceError } from './port.ts';

export interface OpenAiCompatiblePerformanceConfig {
  provider: string;
  baseUrl: string;
  model?: string;
  timeoutMs: number;
  maxOutputTokens: number;
  temperature: number;
}

export class OpenAiCompatiblePerformanceAdapter implements PerformanceInferencePort {
  private readonly config: OpenAiCompatiblePerformanceConfig;
  private readonly fetcher: typeof fetch;

  constructor(config: OpenAiCompatiblePerformanceConfig, fetcher: typeof fetch = fetch) {
    validateConfig(config);
    this.config = { ...config, baseUrl: config.baseUrl.replace(/\/+$/u, '') };
    // Chromium's native Window.fetch validates its receiver. Calling a saved
    // function through `this.fetcher(...)` would bind the Adapter instance and
    // fail with "Illegal invocation", so preserve the owning global explicitly.
    this.fetcher = (input, init) => Reflect.apply(fetcher, globalThis, [input, init]);
  }

  describe(): PerformanceInferenceCapabilities {
    return {
      structuredOutput: 'prompt-only',
      thinkingControl: 'unsupported',
      streaming: false,
    };
  }

  async plan(
    request: PerformancePlanningRequest,
    signal: AbortSignal,
  ): Promise<LocalPerformanceSuggestion> {
    validateRequestEnvelope(request);
    if (signal.aborted) throw abortedError(signal.reason);
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.timeoutMs);

    try {
      const response = await this.fetcher(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(chatRequest(request, this.config)),
        signal: controller.signal,
      });
      if (!response.ok) {
        const details = (await response.text()).slice(0, 500);
        throw new PerformanceInferenceError(
          'performance-http-error',
          `Performance Provider returned HTTP ${response.status}${details ? `: ${details}` : ''}`,
        );
      }
      const body: unknown = await response.json();
      const content = chatContent(body);
      return parseSuggestion(content, request, this.config.provider);
    }
    catch (cause) {
      if (cause instanceof PerformanceInferenceError) throw cause;
      if (signal.aborted) throw abortedError(signal.reason);
      if (timedOut) {
        throw new PerformanceInferenceError(
          'performance-timeout',
          `Performance inference exceeded ${this.config.timeoutMs}ms`,
          { cause },
        );
      }
      throw new PerformanceInferenceError(
        'performance-provider-failure',
        cause instanceof Error ? cause.message : String(cause),
        { cause },
      );
    }
    finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
}

function chatRequest(
  request: PerformancePlanningRequest,
  config: OpenAiCompatiblePerformanceConfig,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages: [
      {
        role: 'system',
        content: [
          'You select a subtle Live2D performance for one already-written reply segment.',
          'Return exactly one JSON object without Markdown or explanation.',
          `Allowed emotion IDs: ${JSON.stringify(request.emotions)}.`,
          `Allowed action IDs: ${JSON.stringify(request.actions.map(action => action.actionId))}.`,
          'Never invent, translate, or paraphrase an ID. Use null/[] when no allowed ID fits.',
          'Prefer no action over a weak or repetitive action.',
          'The result has exactly two top-level fields: emotion and actions.',
          'emotion is null or {"emotion":"ONE_ALLOWED_ID","intensity":0.0,"confidence":0.0,"anchor":"segment-start"}.',
          'actions is an array of at most two {"actionId":"ONE_ALLOWED_ID","confidence":0.0,"anchor":"ONE_ALLOWED_ANCHOR"} objects.',
          'Numbers are JSON numbers from 0 to 1. Do not copy allowed-ID arrays into the result.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          text: request.text,
          persona: request.persona,
          scene: request.scene,
          avatar: request.avatar,
          emotions: request.emotions,
          actionCatalog: request.actions.map(action => ({
            actionId: action.actionId,
            allowedAnchors: action.allowedAnchors,
          })),
        }),
      },
    ],
    max_tokens: config.maxOutputTokens,
    temperature: config.temperature,
    stream: false,
  };
  if (config.model !== undefined) body.model = config.model;
  return body;
}

function chatContent(value: unknown): string {
  const root = record(value, 'chat completion');
  const choices = root.choices;
  if (!Array.isArray(choices) || !choices.length) {
    throw invalidResponse('Chat completion has no choices');
  }
  const choice = record(choices[0], 'chat completion choice');
  const message = record(choice.message, 'chat completion message');
  if (typeof message.content !== 'string' || !message.content.trim()) {
    throw invalidResponse('Chat completion content must be a non-empty string');
  }
  return message.content;
}

export function parseSuggestion(
  content: string,
  request: PerformancePlanningRequest,
  provider: string,
): LocalPerformanceSuggestion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(content));
  }
  catch (cause) {
    throw invalidResponse(
      `Performance Provider did not return valid JSON: ${responsePreview(content)}`,
      cause,
    );
  }
  const root = record(parsed, 'performance suggestion');
  assertKnownKeys(root, ['emotion', 'actions'], 'performance suggestion');
  const emotion = parseEmotion(root.emotion, request);
  const actions = parseActions(root.actions, request.actions);
  return {
    contractVersion: PERFORMANCE_PLANNING_CONTRACT_VERSION,
    requestId: request.requestId,
    segmentId: request.segmentId,
    segmentRevision: request.segmentRevision,
    source: 'model',
    provider,
    ...(emotion ? { emotion } : {}),
    actions,
  };
}

function parseEmotion(
  value: unknown,
  request: PerformancePlanningRequest,
): PerformanceEmotionSuggestion | undefined {
  if (value === null || value === undefined) return undefined;
  const emotion = record(value, 'performance suggestion emotion');
  assertKnownKeys(emotion, ['emotion', 'intensity', 'confidence', 'anchor'], 'performance suggestion emotion');
  if (typeof emotion.emotion !== 'string' || !request.emotions.includes(emotion.emotion as never)) {
    throw invalidResponse(`Suggested emotion is not available: ${String(emotion.emotion)}`);
  }
  if (emotion.anchor !== 'segment-start') {
    throw invalidResponse('Emotion anchor must be segment-start');
  }
  return {
    emotion: emotion.emotion as PerformanceEmotionSuggestion['emotion'],
    intensity: unitNumber(emotion.intensity, 'emotion intensity'),
    confidence: unitNumber(emotion.confidence, 'emotion confidence'),
    anchor: 'segment-start',
  };
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
    assertKnownKeys(action, ['actionId', 'confidence', 'anchor', 'clauseIndex'], `performance suggestion actions[${index}]`);
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

function validateRequestEnvelope(request: PerformancePlanningRequest): void {
  if (request.contractVersion !== PERFORMANCE_PLANNING_CONTRACT_VERSION) {
    throw new PerformanceInferenceError('performance-contract-mismatch', 'Unsupported performance planning contract', {
      recoverable: false,
    });
  }
  if (!request.requestId || !request.planId || !request.segmentId || !request.text.trim()) {
    throw new PerformanceInferenceError('performance-invalid-request', 'Performance request identity and text are required', {
      recoverable: false,
    });
  }
  if (!Number.isInteger(request.segmentRevision) || request.segmentRevision < 0) {
    throw invalidRequest('Performance segmentRevision must be a non-negative integer');
  }
  if (
    !Array.isArray(request.emotions)
    || !request.emotions.length
    || new Set(request.emotions).size !== request.emotions.length
  ) {
    throw invalidRequest('Performance emotion capabilities must be a non-empty unique array');
  }
  if (!Array.isArray(request.actions)) {
    throw invalidRequest('Performance action capabilities must be an array');
  }
  const actionIds = new Set<string>();
  for (const action of request.actions) {
    if (
      !action
      || typeof action.actionId !== 'string'
      || actionIds.has(action.actionId)
      || !Array.isArray(action.allowedAnchors)
      || !action.allowedAnchors.length
    ) {
      throw invalidRequest('Performance action capabilities must have unique IDs and non-empty anchors');
    }
    actionIds.add(action.actionId);
  }
}

function validateConfig(config: OpenAiCompatiblePerformanceConfig): void {
  if (!config.provider.trim()) throw new TypeError('Performance Provider name is required');
  const url = new URL(config.baseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Performance Provider baseUrl must use HTTP or HTTPS');
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new TypeError('Performance Provider timeoutMs must be positive');
  }
  if (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens <= 0) {
    throw new TypeError('Performance Provider maxOutputTokens must be a positive integer');
  }
  if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) {
    throw new TypeError('Performance Provider temperature must be from 0 to 2');
  }
}

function unitNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalidResponse(`${label} must be from 0 to 1`);
  }
  return value;
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

function responsePreview(content: string): string {
  return JSON.stringify(content.trim().slice(0, 400));
}

function invalidResponse(message: string, cause?: unknown): PerformanceInferenceError {
  return new PerformanceInferenceError(
    'performance-invalid-response',
    message,
    cause === undefined ? {} : { cause },
  );
}

function invalidRequest(message: string): PerformanceInferenceError {
  return new PerformanceInferenceError('performance-invalid-request', message, { recoverable: false });
}

function abortedError(cause: unknown): PerformanceInferenceError {
  return new PerformanceInferenceError('performance-aborted', 'Performance inference was cancelled', { cause });
}
