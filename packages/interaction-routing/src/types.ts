export type InteractionOrigin = 'user' | 'task-event' | 'char' | 'system';

export interface InteractionMessage {
  messageId: string;
  sequence: number;
  origin: InteractionOrigin;
  text: string;
  createdAtMs: number;
  references: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
}

export type RouteTarget =
  | { kind: 'character' }
  | { kind: 'task-session'; sessionId: string };

export type RouteDecision =
  | { decision: 'route'; target: RouteTarget; confidence: number }
  | { decision: 'confirm'; candidateSessionIds: readonly string[] }
  | { decision: 'no-match' };

export type TargetSelection =
  | { mode: 'auto' }
  | { mode: 'direct'; target: RouteTarget };

export interface RouteRecord {
  messageId: string;
  selection: TargetSelection;
  decision: RouteDecision;
  visibleContextRevision: number;
  decidedAtMs: number;
}

export interface RouteConfirmationRecord {
  messageId: string;
  sessionId: string;
  visibleContextRevision: number;
  confirmedAtMs: number;
}

export interface MessageExposure {
  messageId: string;
  phase: 'showing' | 'shown';
  visibleText: string;
  complete: boolean;
  exposureRevision: number;
}

export type TaskSessionRouteStatus =
  | 'waiting-input'
  | 'active'
  | 'idle-unknown'
  | 'unavailable';

export interface TaskSessionRouteCandidate {
  sessionId: string;
  title?: string;
  summary?: string;
  status: TaskSessionRouteStatus;
  lastVisibleEvent?: string;
}

export interface RoutingContextSnapshot {
  visibleContextRevision: number;
  characterOnly?: boolean;
  exposures: readonly MessageExposure[];
  candidates: readonly TaskSessionRouteCandidate[];
}

export interface PendingRouteConfirmation {
  messageId: string;
  candidateSessionIds: readonly string[];
  visibleContextRevision: number;
}

export interface RouterAgentRequest {
  message: InteractionMessage;
  visibleContextRevision: number;
  exposures: readonly MessageExposure[];
  candidates: readonly TaskSessionRouteCandidate[];
  pendingConfirmation?: PendingRouteConfirmation;
}

export interface RouterCandidateScore {
  sessionId: string;
  score: number;
  reason: string;
}

export interface RouterAgentResult {
  contextRevision: number;
  route: RouteDecision;
  candidates: readonly RouterCandidateScore[];
}

export interface RouterAgentPort {
  decide(request: RouterAgentRequest, signal: AbortSignal): Promise<RouterAgentResult>;
}

export interface RoutingContextPort {
  freeze(): RoutingContextSnapshot;
}

export interface CharacterRoutePort {
  submit(message: InteractionMessage): Promise<void>;
}

export interface TaskSessionRoutePort {
  isAvailable(sessionId: string): boolean | Promise<boolean>;
  submit(sessionId: string, message: InteractionMessage): Promise<void>;
}

export interface RouteCoordinatorConfig {
  autoSubmitMinConfidence: number;
  autoSubmitMinMargin: number;
  maxTimelineEntries: number;
  maxCandidates: number;
}

export interface RouteCoordinatorOptions {
  router: RouterAgentPort;
  context: RoutingContextPort;
  character: CharacterRoutePort;
  taskSessions: TaskSessionRoutePort;
  config: RouteCoordinatorConfig;
  initialSelection?: TargetSelection;
  idFactory?: () => string;
  now?: () => number;
}

export interface RouteOutcome {
  message: InteractionMessage;
  record: RouteRecord;
  dispatched: boolean;
}

export interface RouteCoordinatorSnapshot {
  selection: TargetSelection;
  messages: readonly InteractionMessage[];
  routes: readonly RouteRecord[];
  confirmations: readonly RouteConfirmationRecord[];
  pendingConfirmation?: PendingRouteConfirmation;
}

export type RouteCoordinatorErrorCode =
  | 'invalid-input'
  | 'router-failed'
  | 'router-invalid-result'
  | 'session-unavailable'
  | 'dispatch-failed'
  | 'confirmation-missing'
  | 'confirmation-invalid'
  | 'confirmation-stale';

export class RouteCoordinatorError extends Error {
  readonly code: RouteCoordinatorErrorCode;

  constructor(code: RouteCoordinatorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RouteCoordinatorError';
    this.code = code;
  }
}
