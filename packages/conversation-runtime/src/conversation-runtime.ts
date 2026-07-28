import type {
  CommitState,
  ConversationMessage,
  ConversationRuntimeOptions,
  ConversationSnapshot,
  PerformancePreparationState,
  PreparedPerformance,
  PreparedSpeech,
  PresentationSegment,
  PresentationState,
  PresentationUnit,
  PreparationState,
  ReplyResult,
  ReplyState,
  ReplyTask,
  ResponseSegmentSnapshot,
  ResponseSlotSnapshot,
  SubmittedTurn,
} from './types.ts';

interface SegmentRecord {
  segmentId: string;
  segmentRevision: number;
  text: string;
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
  reply: ReplyState;
  commit: CommitState;
  presentation: PresentationState;
  controller: AbortController;
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
    this.options = options;
  }

  submitUserMessage(text: string): SubmittedTurn {
    if (this.disposed) throw new Error('ConversationRuntime is disposed');
    const normalized = text.trim();
    if (!normalized) throw new TypeError('User message must not be empty');

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
      reply: 'pending',
      commit: 'waiting',
      presentation: 'waiting',
      controller: new AbortController(),
      segments: [],
    };
    this.responses.push(response);

    const task: ReplyTask = {
      conversationId: this.options.conversationId,
      turnId,
      turnSequence,
      taskId,
      attemptId,
      generation: response.generation,
      baseContextRevision: response.baseContextRevision,
      messages: this.messages.map(cloneMessage),
      userMessage: normalized,
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

  private async runReply(response: ResponseRecord, task: ReplyTask): Promise<void> {
    try {
      const execution = await this.options.connections.dispatch(task, response.controller.signal);
      if (!this.isCurrent(response, task.generation)) return;
      validateReplyResult(task, execution.result);
      response.agentId = execution.agentId;
      response.instanceId = execution.instanceId;
      response.segments = execution.result.segments.map((segment, index) => ({
        segmentId: segment.segmentId || this.id('segment'),
        segmentRevision: 0,
        text: segment.text.trim(),
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
      response.reply = response.controller.signal.aborted ? 'cancelled' : 'failed';
      response.commit = response.reply === 'cancelled' ? 'cancelled' : 'failed';
      response.presentation = response.reply === 'cancelled' ? 'cancelled' : 'failed';
      response.error = errorMessage(error);
      this.advanceCommits();
      this.emit();
      void this.pumpPresentation();
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
}

function validateReplyResult(task: ReplyTask, result: ReplyResult): void {
  if (
    result.conversationId !== task.conversationId
    || result.turnId !== task.turnId
    || result.taskId !== task.taskId
    || result.attemptId !== task.attemptId
    || result.generation !== task.generation
  ) {
    throw new Error('Reply result correlation does not match the active task attempt');
  }
}

function cloneMessage(message: ConversationMessage): ConversationMessage {
  return { ...message };
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
