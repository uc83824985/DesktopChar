export type ReplyCapability = 'reply';

export interface AgentRegistration {
  agentId: string;
  instanceId: string;
  protocolVersion: string;
  capabilities: readonly ReplyCapability[];
  maxConcurrency: number;
  leaseExpiresAtMs?: number;
}

export interface ConversationMessage {
  messageId: string;
  sequence: number;
  role: 'user' | 'assistant';
  text: string;
  turnId: string;
}

export interface ReplyTask {
  conversationId: string;
  turnId: string;
  turnSequence: number;
  taskId: string;
  attemptId: string;
  generation: number;
  baseContextRevision: number;
  messages: readonly ConversationMessage[];
  userMessage: string;
}

export interface ReplySegment {
  segmentId: string;
  text: string;
}

export interface ReplyResult {
  conversationId: string;
  turnId: string;
  taskId: string;
  attemptId: string;
  generation: number;
  segments: readonly ReplySegment[];
}

export interface ReplyAgentEndpoint {
  execute(task: ReplyTask, signal: AbortSignal): Promise<ReplyResult>;
}

export interface AgentExecution {
  agentId: string;
  instanceId: string;
  result: ReplyResult;
}

export interface AgentConnectionSnapshot {
  agentId: string;
  instanceId: string;
  protocolVersion: string;
  capabilities: readonly ReplyCapability[];
  maxConcurrency: number;
  active: number;
  healthy: boolean;
  leaseExpiresAtMs?: number;
}

export interface SpeechPreparationRequest {
  conversationId: string;
  responseId: string;
  turnId: string;
  turnSequence: number;
  segmentId: string;
  segmentRevision: number;
  text: string;
  generation: number;
}

export interface PerformancePreparationRequest extends SpeechPreparationRequest {}

export interface PreparedSpeech {
  preparationId: string;
  value?: unknown;
}

export interface PreparedPerformance {
  preparationId: string;
  value?: unknown;
}

export interface PreparationPort {
  prepareSpeech(request: SpeechPreparationRequest, signal: AbortSignal): Promise<PreparedSpeech>;
  preparePerformance(request: PerformancePreparationRequest, signal: AbortSignal): Promise<PreparedPerformance>;
}

export interface PresentationSegment {
  segmentId: string;
  segmentRevision: number;
  text: string;
  speech?: PreparedSpeech;
  performance?: PreparedPerformance;
}

export interface PresentationUnit {
  conversationId: string;
  responseId: string;
  turnId: string;
  turnSequence: number;
  generation: number;
  segments: readonly PresentationSegment[];
}

export interface PresentationPort {
  present(unit: PresentationUnit, signal: AbortSignal): Promise<void>;
}

export type ReplyState = 'pending' | 'running' | 'sealed' | 'failed' | 'cancelled';
export type PreparationState = 'none' | 'running' | 'ready' | 'failed' | 'cancelled';
export type PerformancePreparationState = PreparationState | 'fallback';
export type CommitState = 'waiting' | 'blocked' | 'committed' | 'failed' | 'cancelled';
export type PresentationState = 'waiting' | 'queued' | 'presenting' | 'completed' | 'failed' | 'cancelled';

export interface ResponseSegmentSnapshot {
  segmentId: string;
  segmentRevision: number;
  text: string;
  speech: PreparationState;
  performance: PerformancePreparationState;
}

export interface ResponseSlotSnapshot {
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
  agentId?: string;
  instanceId?: string;
  error?: string;
  segments: readonly ResponseSegmentSnapshot[];
}

export interface ConversationSnapshot {
  conversationId: string;
  contextRevision: number;
  messages: readonly ConversationMessage[];
  responses: readonly ResponseSlotSnapshot[];
}

export interface SubmittedTurn {
  conversationId: string;
  turnId: string;
  turnSequence: number;
  taskId: string;
  responseId: string;
}

export interface ConversationRuntimeOptions {
  conversationId: string;
  connections: {
    dispatch(task: ReplyTask, signal: AbortSignal): Promise<AgentExecution>;
  };
  preparation: PreparationPort;
  presentation: PresentationPort;
  idFactory?: (kind: 'message' | 'turn' | 'task' | 'attempt' | 'response' | 'segment') => string;
}
