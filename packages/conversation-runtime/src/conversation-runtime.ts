import type {
  CharReplyResult,
  CharReplyTask,
  CommitState,
  ConversationMessage,
  ConversationSubmissionOptions,
  ConversationRuntimeOptions,
  ConversationSnapshot,
  PerformancePreparationState,
  PreparedPerformance,
  PreparedSpeech,
  PresentationSegment,
  PresentationState,
  PresentationUnit,
  PreparationState,
  ReplyState,
  ResponseSegmentSnapshot,
  ResponseSlotSnapshot,
  SubmittedTurn,
} from './types.ts';

interface SegmentRecord {
  segmentId: string;
  segmentRevision: number;
  text: string;
  source: 'agent' | 'application-fallback';
  speech: PreparationState;
  performance: PerformancePreparationState;
  preparedSpeech?: PreparedSpeech;
  preparedPerformance?: PreparedPerformance;
}

interface ResponseRecord {
  responseId: string;
  conversationId: string;
  turnId: string;
  turnSequence: number;
  taskId: string;
  attemptId: string;
  generation: number;
  baseContextRevision: number;
  personaRevision: number;
  deadlineAtMs: number;
  reply: ReplyState;
  commit: CommitState;
  presentation: PresentationState;
  controller: AbortController;
  applicationFallbackText: string;
  agentId?: string;
  instanceId?: string;
  error?: string;
  segments: SegmentRecord[];
}

export class ConversationRuntime {
  private readonly options: ConversationRuntimeOptions;
  private readonly messages: ConversationMessage[] = [];
  private readonly responses: ResponseRecord[] = [];
  private readonly listeners = new Set<(snapshot: ConversationSnapshot) => void>();
  private readonly idleWaiters = new Set<() => void>();
  private contextRevision = 0;
  private messageSequence = 0;
  private turnSequence = 0;
  private presentationRunning = false;
  private disposed = false;

  constructor(options: ConversationRuntimeOptions) {
    if (!options.conversationId.trim()) throw new TypeError('ConversationRuntime requires a conversationId');
    validatePersona(options.persona);
    if (!Number.isInteger(options.personaRevision) || options.personaRevision < 0) {
      throw new RangeError('ConversationRuntime personaRevision must be a non-negative integer');
    }
    if (!Number.isFinite(options.replyTimeoutMs) || options.replyTimeoutMs <= 0) {
      throw new RangeError('ConversationRuntime replyTimeoutMs must be positive and finite');
    }
    if (!options.applicationFallbackText.trim()) {
      throw new TypeError('ConversationRuntime applicationFallbackText must not be empty');
    }
    this.options = options;
  }

  submitUserMessage(
    text: string,
    submission: ConversationSubmissionOptions = {},
  ): SubmittedTurn {
    if (this.disposed) throw new Error('ConversationRuntime is disposed');
    const normalized = text.trim();
    if (!normalized) throw new TypeError('User message must not be empty');
    const applicationFallbackText = (
      submission.applicationFallbackText ?? this.options.applicationFallbackText
    ).trim();
    if (!applicationFallbackText) {
      throw new TypeError('Turn applicationFallbackText must not be empty');
    }
    const turnId = this.id('turn');
    const taskId = this.id('task');
    const attemptId = this.id('attempt');
    const responseId = this.id('response');
    const turnSequence = this.turnSequence++;
    const userMessage: ConversationMessage = {
      messageId: this.id('message'),
      sequence: this.messageSequence++,
      role: 'user',
      text: normalized,
      turnId,
    };
    this.messages.push(userMessage);
    this.contextRevision++;

    const response: ResponseRecord = {
      responseId,
      conversationId: this.options.conversationId,
      turnId,
      turnSequence,
      taskId,
      attemptId,
      generation: 0,
      baseContextRevision: this.contextRevision,
      personaRevision: this.options.personaRevision,
      deadlineAtMs: this.now() + this.options.replyTimeoutMs,
      reply: 'pending',
      commit: 'waiting',
      presentation: 'waiting',
      controller: new AbortController(),
      applicationFallbackText,
      segments: [],
    };
    this.responses.push(response);

    const task: CharReplyTask = {
      conversationId: this.options.conversationId,
      turnId,
      turnSequence,
      taskId,
      attemptId,
      generation: response.generation,
      deadlineAtMs: response.deadlineAtMs,
      context: {
        schemaVersion: 'desktop-char.char-context.v1',
        baseContextRevision: response.baseContextRevision,
        personaRevision: response.personaRevision,
        persona: clonePersona(this.options.persona),
        messages: this.messages.map(cloneMessage),
        focusMessageId: userMessage.messageId,
      },
    };
    response.reply = 'running';
    this.emit();
    void this.runReply(response, task);
    return { conversationId: this.options.conversationId, turnId, turnSequence, taskId, responseId };
  }

  cancelTurn(turnId: string): boolean {
    const response = this.responses.find(candidate => candidate.turnId === turnId);
    if (!response || terminalPresentation(response.presentation)) return false;
    response.generation++;
    response.controller.abort(new DOMException('Turn cancelled', 'AbortError'));
    response.reply = 'cancelled';
    response.commit = 'cancelled';
    response.presentation = 'cancelled';
    for (const segment of response.segments) {
      if (segment.speech === 'running') segment.speech = 'cancelled';
      if (segment.performance === 'running') segment.performance = 'cancelled';
    }
    this.advanceCommits();
    this.emit();
    void this.pumpPresentation();
    return true;
  }

  getSnapshot(): ConversationSnapshot {
    return {
      conversationId: this.options.conversationId,
      contextRevision: this.contextRevision,
      messages: this.messages.map(cloneMessage),
      responses: this.responses.map(snapshotResponse),
    };
  }

  subscribe(listener: (snapshot: ConversationSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.add(resolve));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const response of this.responses) {
      if (!terminalPresentation(response.presentation)) {
        response.controller.abort(new DOMException('ConversationRuntime disposed', 'AbortError'));
      }
    }
    this.listeners.clear();
    this.resolveIdleWaiters();
  }

  private async runReply(response: ResponseRecord, task: CharReplyTask): Promise<void> {
    const timeout = setTimeout(
      () => response.controller.abort(new Error(`Char reply timed out at ${task.deadlineAtMs}`)),
      Math.max(0, task.deadlineAtMs - this.now()),
    );
    try {
      const execution = await this.options.connections.dispatch(task, response.controller.signal);
      if (!this.isCurrent(response, task.generation)) return;
      validateCharReplyResult(task, execution.result);
      response.agentId = execution.agentId;
      response.instanceId = execution.instanceId;
      response.segments = execution.result.segments.map((segment, index) => ({
        segmentId: segment.segmentId || this.id('segment'),
        segmentRevision: 0,
        text: segment.text.trim(),
        source: 'agent',
        speech: 'none',
        performance: 'none',
      }));
      if (response.segments.length === 0 || response.segments.some(segment => !segment.text)) {
        throw new Error('Reply result must contain at least one non-empty segment');
      }
      response.reply = 'sealed';
      this.emit();
      this.startPreparations(response);
      this.advanceCommits();
      this.emit();
      void this.pumpPresentation();
    }
    catch (error) {
      if (!this.isCurrent(response, task.generation)) return;
      response.error = errorMessage(error);
      response.reply = 'sealed';
      response.segments = [{
        segmentId: this.id('segment'),
        segmentRevision: 0,
        text: response.applicationFallbackText,
        source: 'application-fallback',
        speech: 'none',
        performance: 'none',
      }];
      this.startPreparations(response);
      this.advanceCommits();
      this.emit();
      void this.pumpPresentation();
    }
    finally {
      clearTimeout(timeout);
    }
  }

  private startPreparations(response: ResponseRecord): void {
    for (const segment of response.segments) {
      segment.speech = 'running';
      segment.performance = 'running';
      const request = {
        conversationId: response.conversationId,
        responseId: response.responseId,
        turnId: response.turnId,
        turnSequence: response.turnSequence,
        segmentId: segment.segmentId,
        segmentRevision: segment.segmentRevision,
        text: segment.text,
        generation: response.generation,
      };
      void this.options.preparation.prepareSpeech(request, response.controller.signal)
        .then(value => {
          if (!this.isCurrent(response, request.generation)) return;
          segment.preparedSpeech = value;
          segment.speech = 'ready';
        })
        .catch(error => {
          if (!this.isCurrent(response, request.generation)) return;
          segment.speech = response.controller.signal.aborted ? 'cancelled' : 'failed';
          response.error ??= errorMessage(error);
        })
        .finally(() => {
          if (!this.isCurrent(response, request.generation)) return;
          this.emit();
          void this.pumpPresentation();
        });
      void this.options.preparation.preparePerformance(request, response.controller.signal)
        .then(value => {
          if (!this.isCurrent(response, request.generation)) return;
          segment.preparedPerformance = value;
          segment.performance = 'ready';
        })
        .catch(error => {
          if (!this.isCurrent(response, request.generation)) return;
          segment.performance = response.controller.signal.aborted ? 'cancelled' : 'fallback';
          response.error ??= errorMessage(error);
        })
        .finally(() => {
          if (!this.isCurrent(response, request.generation)) return;
          this.emit();
          void this.pumpPresentation();
        });
    }
    this.emit();
  }

  private advanceCommits(): void {
    let blocked = false;
    for (const response of this.responses) {
      if (terminalCommit(response.commit)) continue;
      if (blocked) {
        if (response.reply === 'sealed') response.commit = 'blocked';
        continue;
      }
      if (response.reply === 'failed') {
        response.commit = 'failed';
        response.presentation = 'failed';
        continue;
      }
      if (response.reply === 'cancelled') {
        response.commit = 'cancelled';
        response.presentation = 'cancelled';
        continue;
      }
      if (response.reply !== 'sealed') {
        blocked = true;
        continue;
      }
      response.commit = 'committed';
      const assistantText = response.segments.map(segment => segment.text).join('');
      this.messages.push({
        messageId: this.id('message'),
        sequence: this.messageSequence++,
        role: 'assistant',
        text: assistantText,
        turnId: response.turnId,
      });
      this.contextRevision++;
    }
  }

  private async pumpPresentation(): Promise<void> {
    if (this.presentationRunning || this.disposed) return;
    const candidate = this.responses.find(response => !terminalPresentation(response.presentation));
    if (!candidate) {
      this.resolveIdleWaiters();
      return;
    }
    if (candidate.commit !== 'committed' || !preparationsTerminal(candidate.segments)) return;

    this.presentationRunning = true;
    candidate.presentation = 'queued';
    this.emit();
    const unit = presentationUnit(candidate);
    candidate.presentation = 'presenting';
    this.emit();
    try {
      await this.options.presentation.present(unit, candidate.controller.signal);
      if (candidate.presentation === 'presenting') candidate.presentation = 'completed';
    }
    catch (error) {
      if (candidate.presentation === 'presenting') {
        candidate.presentation = candidate.controller.signal.aborted ? 'cancelled' : 'failed';
        candidate.error ??= errorMessage(error);
      }
    }
    finally {
      this.presentationRunning = false;
      this.emit();
      void this.pumpPresentation();
    }
  }

  private isCurrent(response: ResponseRecord, generation: number): boolean {
    return !this.disposed && response.generation === generation;
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
    if (this.isIdle()) this.resolveIdleWaiters();
  }

  private isIdle(): boolean {
    return !this.presentationRunning
      && this.responses.every(response => terminalPresentation(response.presentation));
  }

  private resolveIdleWaiters(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private id(kind: 'message' | 'turn' | 'task' | 'attempt' | 'response' | 'segment'): string {
    return this.options.idFactory?.(kind) ?? `${kind}-${globalThis.crypto.randomUUID()}`;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function validateCharReplyResult(task: CharReplyTask, result: CharReplyResult): void {
  if (
    result.conversationId !== task.conversationId
    || result.turnId !== task.turnId
    || result.taskId !== task.taskId
    || result.attemptId !== task.attemptId
    || result.generation !== task.generation
    || result.baseContextRevision !== task.context.baseContextRevision
    || result.personaRevision !== task.context.personaRevision
  ) {
    throw new Error('Char reply result correlation does not match the active task attempt');
  }
}

function cloneMessage(message: ConversationMessage): ConversationMessage {
  return { ...message };
}

function clonePersona(persona: ConversationRuntimeOptions['persona']): ConversationRuntimeOptions['persona'] {
  return { name: persona.name, instructions: [...persona.instructions] };
}

function validatePersona(persona: ConversationRuntimeOptions['persona']): void {
  if (!persona.name.trim()) throw new TypeError('Persona name must not be empty');
  if (!Array.isArray(persona.instructions) || persona.instructions.some(instruction => !instruction.trim())) {
    throw new TypeError('Persona instructions must contain only non-empty strings');
  }
}

function snapshotResponse(response: ResponseRecord): ResponseSlotSnapshot {
  return {
    responseId: response.responseId,
    conversationId: response.conversationId,
    turnId: response.turnId,
    turnSequence: response.turnSequence,
    taskId: response.taskId,
    attemptId: response.attemptId,
    generation: response.generation,
    baseContextRevision: response.baseContextRevision,
    personaRevision: response.personaRevision,
    deadlineAtMs: response.deadlineAtMs,
    reply: response.reply,
    commit: response.commit,
    presentation: response.presentation,
    ...(response.agentId === undefined ? {} : { agentId: response.agentId }),
    ...(response.instanceId === undefined ? {} : { instanceId: response.instanceId }),
    ...(response.error === undefined ? {} : { error: response.error }),
    segments: response.segments.map(snapshotSegment),
  };
}

function snapshotSegment(segment: SegmentRecord): ResponseSegmentSnapshot {
  return {
    segmentId: segment.segmentId,
    segmentRevision: segment.segmentRevision,
    text: segment.text,
    source: segment.source,
    speech: segment.speech,
    performance: segment.performance,
  };
}

function presentationUnit(response: ResponseRecord): PresentationUnit {
  return {
    conversationId: response.conversationId,
    responseId: response.responseId,
    turnId: response.turnId,
    turnSequence: response.turnSequence,
    generation: response.generation,
    segments: response.segments.map(segment => {
      const result: PresentationSegment = {
        segmentId: segment.segmentId,
        segmentRevision: segment.segmentRevision,
        text: segment.text,
        source: segment.source,
      };
      if (segment.preparedSpeech !== undefined) result.speech = segment.preparedSpeech;
      if (segment.preparedPerformance !== undefined) result.performance = segment.preparedPerformance;
      return result;
    }),
  };
}

function preparationsTerminal(segments: readonly SegmentRecord[]): boolean {
  return segments.length > 0 && segments.every(segment =>
    ['ready', 'failed', 'cancelled'].includes(segment.speech)
    && ['ready', 'fallback', 'failed', 'cancelled'].includes(segment.performance));
}

function terminalCommit(state: CommitState): boolean {
  return state === 'committed' || state === 'failed' || state === 'cancelled';
}

function terminalPresentation(state: PresentationState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
