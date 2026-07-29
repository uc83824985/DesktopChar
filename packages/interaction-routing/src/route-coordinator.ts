import {
  RouteCoordinatorError,
  type InteractionMessage,
  type PendingRouteConfirmation,
  type RouteConfirmationRecord,
  type RouteCoordinatorConfig,
  type RouteCoordinatorOptions,
  type RouteCoordinatorSnapshot,
  type RouteDecision,
  type RouteOutcome,
  type RouteRecord,
  type RouterAgentRequest,
  type RouterAgentResult,
  type RouterCandidateScore,
  type RoutingContextSnapshot,
  type TargetSelection,
  type TaskSessionRouteCandidate,
} from './types.ts';

export class RouteCoordinator {
  private readonly options: RouteCoordinatorOptions;
  private readonly messages: InteractionMessage[] = [];
  private readonly routes: RouteRecord[] = [];
  private readonly confirmations: RouteConfirmationRecord[] = [];
  private readonly config: RouteCoordinatorConfig;
  private selection: TargetSelection;
  private pendingConfirmation: PendingRouteConfirmation | undefined;
  private sequence = 0;

  constructor(options: RouteCoordinatorOptions) {
    this.options = options;
    this.config = validateConfig(options.config);
    this.selection = cloneSelection(options.initialSelection ?? { mode: 'auto' });
  }

  setSelection(selection: TargetSelection): void {
    this.selection = validateSelection(selection);
  }

  getSelection(): TargetSelection {
    return cloneSelection(this.selection);
  }

  async acceptUserMessage(text: string, signal = new AbortController().signal): Promise<RouteOutcome> {
    const normalized = nonEmptyText(text, 'Interaction message text');
    const message: InteractionMessage = {
      messageId: this.options.idFactory?.() ?? `interaction-${globalThis.crypto.randomUUID()}`,
      sequence: this.sequence++,
      origin: 'user',
      text: normalized,
      createdAtMs: this.now(),
      references: [],
    };
    this.messages.push(cloneMessage(message));

    const selection = cloneSelection(this.selection);
    const context = freezeContext(this.options.context.freeze(), this.config);
    let decision: RouteDecision;
    if (selection.mode === 'direct') {
      decision = { decision: 'route', target: cloneTarget(selection.target), confidence: 1 };
    }
    else if (context.characterOnly || context.candidates.length === 0) {
      decision = { decision: 'route', target: { kind: 'character' }, confidence: 1 };
    }
    else {
      decision = await this.requestAutomaticDecision(message, context, signal);
    }

    const record: RouteRecord = {
      messageId: message.messageId,
      selection,
      decision: cloneDecision(decision),
      visibleContextRevision: context.visibleContextRevision,
      decidedAtMs: this.now(),
    };
    const dispatched = await this.dispatch(
      message,
      decision,
      context.visibleContextRevision,
    );
    this.routes.push(cloneRecord(record));
    if (decision.decision === 'confirm') {
      this.pendingConfirmation = {
        messageId: message.messageId,
        candidateSessionIds: [...decision.candidateSessionIds],
        visibleContextRevision: context.visibleContextRevision,
      };
    }
    return {
      message: cloneMessage(message),
      record: cloneRecord(record),
      dispatched,
    };
  }

  async confirmPendingRoute(
    messageId: string,
    sessionId: string,
    visibleContextRevision: number,
  ): Promise<RouteConfirmationRecord> {
    const pending = this.pendingConfirmation;
    if (!pending || pending.messageId !== messageId) {
      throw new RouteCoordinatorError(
        'confirmation-missing',
        `No pending route confirmation exists for message ${messageId}`,
      );
    }
    if (!pending.candidateSessionIds.includes(sessionId)) {
      throw new RouteCoordinatorError(
        'confirmation-invalid',
        `Session ${sessionId} is not part of the pending route confirmation`,
      );
    }
    const currentContext = freezeContext(this.options.context.freeze(), this.config);
    if (
      visibleContextRevision !== pending.visibleContextRevision
      || currentContext.visibleContextRevision !== pending.visibleContextRevision
    ) {
      throw new RouteCoordinatorError(
        'confirmation-stale',
        `Route confirmation for message ${messageId} no longer matches the visible context`,
      );
    }
    if (!await this.options.taskSessions.isAvailable(sessionId)) {
      throw new RouteCoordinatorError(
        'session-unavailable',
        `Task session ${sessionId} is unavailable`,
      );
    }
    const message = this.messages.find(item => item.messageId === messageId);
    if (!message) {
      throw new RouteCoordinatorError(
        'confirmation-missing',
        `Interaction message ${messageId} is unavailable`,
      );
    }
    try {
      await this.options.taskSessions.submit(
        sessionId,
        cloneMessage(message),
        visibleContextRevision,
      );
    }
    catch (error) {
      throw new RouteCoordinatorError(
        'dispatch-failed',
        `Task session ${sessionId} rejected the confirmed message`,
        { cause: error },
      );
    }
    const confirmation: RouteConfirmationRecord = {
      messageId,
      sessionId,
      visibleContextRevision,
      confirmedAtMs: this.now(),
    };
    this.confirmations.push({ ...confirmation });
    this.pendingConfirmation = undefined;
    return { ...confirmation };
  }

  cancelPendingConfirmation(messageId?: string): boolean {
    if (!this.pendingConfirmation) return false;
    if (messageId !== undefined && this.pendingConfirmation.messageId !== messageId) return false;
    this.pendingConfirmation = undefined;
    return true;
  }

  getSnapshot(): RouteCoordinatorSnapshot {
    return {
      selection: cloneSelection(this.selection),
      messages: this.messages.map(cloneMessage),
      routes: this.routes.map(cloneRecord),
      confirmations: this.confirmations.map(item => ({ ...item })),
      ...(this.pendingConfirmation
        ? { pendingConfirmation: clonePendingConfirmation(this.pendingConfirmation) }
        : {}),
    };
  }

  private async requestAutomaticDecision(
    message: InteractionMessage,
    context: RoutingContextSnapshot,
    signal: AbortSignal,
  ): Promise<RouteDecision> {
    const request: RouterAgentRequest = {
      message: cloneMessage(message),
      visibleContextRevision: context.visibleContextRevision,
      exposures: context.exposures.map(item => ({ ...item })),
      candidates: context.candidates.map(cloneCandidate),
      ...(this.pendingConfirmation
        ? { pendingConfirmation: clonePendingConfirmation(this.pendingConfirmation) }
        : {}),
    };
    let rawResult: RouterAgentResult;
    try {
      rawResult = await this.options.router.decide(request, signal);
    }
    catch (error) {
      throw new RouteCoordinatorError(
        'router-failed',
        'Router Agent failed; the message was not dispatched',
        { cause: error },
      );
    }
    try {
      const result = validateRouterResult(rawResult, request);
      return arbitrateAutomaticDecision(result, this.config);
    }
    catch (error) {
      throw new RouteCoordinatorError(
        'router-invalid-result',
        'Router Agent returned an invalid result; the message was not dispatched',
        { cause: error },
      );
    }
  }

  private async dispatch(
    message: InteractionMessage,
    decision: RouteDecision,
    visibleContextRevision: number,
  ): Promise<boolean> {
    if (decision.decision !== 'route') return false;
    if (decision.target.kind === 'character') {
      try {
        await this.options.character.submit(cloneMessage(message));
      }
      catch (error) {
        throw new RouteCoordinatorError(
          'dispatch-failed',
          'Character dispatcher rejected the routed message',
          { cause: error },
        );
      }
      return true;
    }
    const sessionId = decision.target.sessionId;
    if (!await this.options.taskSessions.isAvailable(sessionId)) {
      throw new RouteCoordinatorError(
        'session-unavailable',
        `Task session ${sessionId} is unavailable`,
      );
    }
    try {
      await this.options.taskSessions.submit(
        sessionId,
        cloneMessage(message),
        visibleContextRevision,
      );
    }
    catch (error) {
      throw new RouteCoordinatorError(
        'dispatch-failed',
        `Task session ${sessionId} rejected the routed message`,
        { cause: error },
      );
    }
    return true;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function arbitrateAutomaticDecision(
  result: RouterAgentResult,
  config: RouteCoordinatorConfig,
): RouteDecision {
  if (result.route.decision === 'no-match') return { decision: 'no-match' };
  if (result.route.decision === 'route' && result.route.target.kind === 'character') {
    return cloneDecision(result.route);
  }

  const candidateIds = result.route.decision === 'confirm'
    ? new Set(result.route.candidateSessionIds)
    : new Set(result.candidates.map(candidate => candidate.sessionId));
  const ranked = result.candidates
    .filter(candidate => candidateIds.has(candidate.sessionId))
    .sort((left, right) => right.score - left.score || left.sessionId.localeCompare(right.sessionId));
  const top = ranked[0];
  if (!top) return { decision: 'no-match' };

  const runnerUp = ranked[1];
  const confidence = result.route.decision === 'route'
    ? Math.min(result.route.confidence, top.score)
    : top.score;
  const margin = top.score - (runnerUp?.score ?? 0);
  if (
    confidence >= config.autoSubmitMinConfidence
    && margin >= config.autoSubmitMinMargin
  ) {
    return {
      decision: 'route',
      target: { kind: 'task-session', sessionId: top.sessionId },
      confidence,
    };
  }

  const confirmationFloor = Math.max(
    0,
    config.autoSubmitMinConfidence - config.autoSubmitMinMargin,
  );
  const closeCandidates = ranked.filter(candidate =>
    candidate.score >= confirmationFloor
    && top.score - candidate.score < config.autoSubmitMinMargin);
  if (closeCandidates.length >= 2) {
    return {
      decision: 'confirm',
      candidateSessionIds: closeCandidates.map(candidate => candidate.sessionId),
    };
  }
  return { decision: 'no-match' };
}

function validateRouterResult(
  value: RouterAgentResult,
  request: RouterAgentRequest,
): RouterAgentResult {
  if (!record(value)) throw new TypeError('Router result must be an object');
  exactKeys(value, ['contextRevision', 'route', 'candidates'], 'Router result');
  if (
    !Number.isInteger(value.contextRevision)
    || value.contextRevision !== request.visibleContextRevision
  ) {
    throw new TypeError('Router result contextRevision does not match the frozen request');
  }
  if (!Array.isArray(value.candidates)) throw new TypeError('Router result candidates must be an array');
  const allowedSessionIds = new Set(request.candidates.map(candidate => candidate.sessionId));
  const seen = new Set<string>();
  const candidates = value.candidates.map((candidate, index) => {
    if (!record(candidate)) throw new TypeError(`Router candidate ${index} must be an object`);
    exactKeys(candidate, ['sessionId', 'score', 'reason'], `Router candidate ${index}`);
    const sessionId = nonEmptyText(candidate.sessionId, `Router candidate ${index} sessionId`);
    if (!allowedSessionIds.has(sessionId)) {
      throw new TypeError(`Router candidate ${sessionId} was not present in the frozen request`);
    }
    if (seen.has(sessionId)) throw new TypeError(`Router candidate ${sessionId} is duplicated`);
    seen.add(sessionId);
    return {
      sessionId,
      score: probability(candidate.score, `Router candidate ${sessionId} score`),
      reason: nonEmptyText(candidate.reason, `Router candidate ${sessionId} reason`),
    };
  });
  const route = validateDecision(value.route, allowedSessionIds, seen);
  if (route.decision === 'route' && route.target.kind === 'task-session') {
    const ranked = [...candidates]
      .sort((left, right) => right.score - left.score || left.sessionId.localeCompare(right.sessionId));
    if (ranked[0]?.sessionId !== route.target.sessionId) {
      throw new TypeError('Router task-session target must be its highest-scored candidate');
    }
  }
  return {
    contextRevision: value.contextRevision,
    route,
    candidates,
  };
}

function validateDecision(
  value: unknown,
  allowedSessionIds: ReadonlySet<string>,
  scoredSessionIds: ReadonlySet<string>,
): RouteDecision {
  if (!record(value)) throw new TypeError('Router decision must be an object');
  if (value.decision === 'no-match') {
    exactKeys(value, ['decision'], 'no-match decision');
    return { decision: 'no-match' };
  }
  if (value.decision === 'route') {
    exactKeys(value, ['decision', 'target', 'confidence'], 'route decision');
    const target = validateTarget(value.target);
    if (target.kind === 'task-session'
      && (!allowedSessionIds.has(target.sessionId) || !scoredSessionIds.has(target.sessionId))) {
      throw new TypeError(`Router target ${target.sessionId} is not a scored frozen candidate`);
    }
    return {
      decision: 'route',
      target,
      confidence: probability(value.confidence, 'Router route confidence'),
    };
  }
  if (value.decision === 'confirm') {
    exactKeys(value, ['decision', 'candidateSessionIds'], 'confirm decision');
    if (!Array.isArray(value.candidateSessionIds) || value.candidateSessionIds.length < 2) {
      throw new TypeError('Router confirm decision requires at least two candidates');
    }
    const candidateSessionIds = value.candidateSessionIds.map((sessionId, index) =>
      nonEmptyText(sessionId, `Router confirm candidate ${index}`));
    if (new Set(candidateSessionIds).size !== candidateSessionIds.length) {
      throw new TypeError('Router confirm candidates must be unique');
    }
    if (candidateSessionIds.some(sessionId =>
      !allowedSessionIds.has(sessionId) || !scoredSessionIds.has(sessionId))) {
      throw new TypeError('Router confirm decision contains an unscored or unknown candidate');
    }
    return { decision: 'confirm', candidateSessionIds };
  }
  throw new TypeError('Router decision kind is unsupported');
}

function validateTarget(value: unknown): { kind: 'character' } | { kind: 'task-session'; sessionId: string };
function validateTarget(value: unknown): { kind: 'character' } | { kind: 'task-session'; sessionId: string } {
  if (!record(value)) throw new TypeError('Route target must be an object');
  if (value.kind === 'character') {
    exactKeys(value, ['kind'], 'character target');
    return { kind: 'character' };
  }
  if (value.kind === 'task-session') {
    exactKeys(value, ['kind', 'sessionId'], 'task-session target');
    return { kind: 'task-session', sessionId: nonEmptyText(value.sessionId, 'Route target sessionId') };
  }
  throw new TypeError('Route target kind is unsupported');
}

function freezeContext(
  value: RoutingContextSnapshot,
  config: RouteCoordinatorConfig,
): RoutingContextSnapshot {
  if (!record(value) || !Number.isInteger(value.visibleContextRevision)
    || value.visibleContextRevision < 0) {
    throw new RouteCoordinatorError('invalid-input', 'Routing context revision must be non-negative');
  }
  if (!Array.isArray(value.exposures) || !Array.isArray(value.candidates)) {
    throw new RouteCoordinatorError('invalid-input', 'Routing context collections must be arrays');
  }
  const exposures = value.exposures.slice(-config.maxTimelineEntries).map((exposure, index) => {
    if (!record(exposure) || !['showing', 'shown'].includes(String(exposure.phase))) {
      throw new RouteCoordinatorError('invalid-input', `Message exposure ${index} is invalid`);
    }
    const phase = exposure.phase as 'showing' | 'shown';
    return {
      messageId: nonEmptyText(exposure.messageId, `Message exposure ${index} messageId`),
      phase,
      visibleText: typeof exposure.visibleText === 'string'
        ? exposure.visibleText
        : invalidContext(`Message exposure ${index} visibleText must be a string`),
      complete: boolean(exposure.complete, `Message exposure ${index} complete`),
      exposureRevision: nonNegativeInteger(
        exposure.exposureRevision,
        `Message exposure ${index} exposureRevision`,
      ),
    };
  });
  const seen = new Set<string>();
  const candidates = value.candidates.slice(0, config.maxCandidates).map((candidate, index) => {
    if (!record(candidate)) {
      throw new RouteCoordinatorError('invalid-input', `Task session candidate ${index} is invalid`);
    }
    const sessionId = nonEmptyText(candidate.sessionId, `Task session candidate ${index} sessionId`);
    if (seen.has(sessionId)) {
      throw new RouteCoordinatorError('invalid-input', `Task session candidate ${sessionId} is duplicated`);
    }
    seen.add(sessionId);
    if (!['waiting-input', 'active', 'idle-unknown', 'unavailable'].includes(String(candidate.status))) {
      throw new RouteCoordinatorError('invalid-input', `Task session candidate ${sessionId} status is invalid`);
    }
    const status = candidate.status as TaskSessionRouteCandidate['status'];
    const result: TaskSessionRouteCandidate = {
      sessionId,
      status,
    };
    if (candidate.title !== undefined) result.title = String(candidate.title);
    if (candidate.summary !== undefined) result.summary = String(candidate.summary);
    if (candidate.lastVisibleEvent !== undefined) result.lastVisibleEvent = String(candidate.lastVisibleEvent);
    return result;
  });
  return {
    visibleContextRevision: value.visibleContextRevision,
    ...(value.characterOnly !== undefined
      ? { characterOnly: boolean(value.characterOnly, 'Routing context characterOnly') }
      : {}),
    exposures,
    candidates,
  };
}

function validateConfig(value: RouteCoordinatorConfig): RouteCoordinatorConfig {
  return {
    autoSubmitMinConfidence: probability(
      value.autoSubmitMinConfidence,
      'autoSubmitMinConfidence',
    ),
    autoSubmitMinMargin: probability(value.autoSubmitMinMargin, 'autoSubmitMinMargin'),
    maxTimelineEntries: positiveInteger(value.maxTimelineEntries, 'maxTimelineEntries'),
    maxCandidates: positiveInteger(value.maxCandidates, 'maxCandidates'),
  };
}

function validateSelection(value: TargetSelection): TargetSelection {
  if (!record(value)) throw new RouteCoordinatorError('invalid-input', 'Target selection must be an object');
  if (value.mode === 'auto') return { mode: 'auto' };
  if (value.mode === 'direct') {
    try {
      return { mode: 'direct', target: validateTarget(value.target) };
    }
    catch (error) {
      throw new RouteCoordinatorError('invalid-input', 'Direct target selection is invalid', { cause: error });
    }
  }
  throw new RouteCoordinatorError('invalid-input', 'Target selection mode is unsupported');
}

function cloneSelection(selection: TargetSelection): TargetSelection {
  return selection.mode === 'auto'
    ? { mode: 'auto' }
    : { mode: 'direct', target: cloneTarget(selection.target) };
}

function cloneTarget(target: { kind: 'character' } | { kind: 'task-session'; sessionId: string }) {
  return target.kind === 'character'
    ? { kind: 'character' } as const
    : { kind: 'task-session', sessionId: target.sessionId } as const;
}

function cloneDecision(decision: RouteDecision): RouteDecision {
  if (decision.decision === 'no-match') return { decision: 'no-match' };
  if (decision.decision === 'confirm') {
    return { decision: 'confirm', candidateSessionIds: [...decision.candidateSessionIds] };
  }
  return {
    decision: 'route',
    target: cloneTarget(decision.target),
    confidence: decision.confidence,
  };
}

function cloneRecord(record: RouteRecord): RouteRecord {
  return {
    messageId: record.messageId,
    selection: cloneSelection(record.selection),
    decision: cloneDecision(record.decision),
    visibleContextRevision: record.visibleContextRevision,
    decidedAtMs: record.decidedAtMs,
  };
}

function cloneMessage(message: InteractionMessage): InteractionMessage {
  return {
    ...message,
    references: [...message.references],
    ...(message.metadata ? { metadata: structuredClone(message.metadata) } : {}),
  };
}

function cloneCandidate(candidate: TaskSessionRouteCandidate): TaskSessionRouteCandidate {
  return { ...candidate };
}

function clonePendingConfirmation(
  pending: PendingRouteConfirmation,
): PendingRouteConfirmation {
  return {
    messageId: pending.messageId,
    candidateSessionIds: [...pending.candidateSessionIds],
    visibleContextRevision: pending.visibleContextRevision,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const allowed = new Set(expected);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) throw new TypeError(`${label} contains unknown field ${unknown[0]}`);
}

function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RouteCoordinatorError('invalid-input', `${label} must be a non-empty string`);
  }
  return value.trim();
}

function probability(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be between 0 and 1`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new RouteCoordinatorError('invalid-input', `${label} must be a non-negative integer`);
  }
  return value as number;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new RouteCoordinatorError('invalid-input', `${label} must be a boolean`);
  }
  return value;
}

function invalidContext(message: string): never {
  throw new RouteCoordinatorError('invalid-input', message);
}
