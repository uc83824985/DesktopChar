export interface DesktopRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopPoint {
  x: number;
  y: number;
}

export interface DesktopWindowState {
  bounds: DesktopRectangle;
  mousePassthrough: boolean;
  pointerPresentation: PointerPresentation;
  alwaysOnTop: boolean;
  visible: boolean;
  visibilityIntent: boolean;
  nativeWindow: {
    backend: string;
    topmost: boolean | null;
    exStyle: string | null;
    eventMonitor: {
      disposed: boolean;
      eventCheckPending: boolean;
      incidentRetryActive: boolean;
      pendingReasons: string[];
      nativeMessageCount: number;
      reconcileCount: number;
      lastReason: string | null;
      lastOutcome: string | null;
    } | null;
  };
  presentation: {
    phase: 'hidden' | 'warming' | 'visible';
    requestId: number;
    opacity: number;
    backgroundThrottling: boolean;
  };
  tray: { available: boolean; iconScaleFactors: number[] };
  interaction: DesktopInteractionConfig;
  conversationSidebar: ConversationSidebarLayoutState;
  agentRoles: DesktopAgentRolesConfig;
  character: DesktopCharacterConfig;
  performanceInference: DesktopPerformanceInferenceConfig;
  tts: DesktopTtsConfig;
  mcpServices: McpServicesState;
  taskManager: TaskManagerState;
  conversationSessions: ConversationSessionRegistryState;
  routerAgent: RouterAgentState;
}

export interface DesktopCharacterConfig {
  profileUrl: string;
}

export interface DesktopInteractionConfig {
  dragHoldDelayMs: number;
  dragWindowApi: 'native-set-window-pos' | 'setBounds';
  conversationSidebar: {
    preferredSide: 'left' | 'right';
  };
  textDisplay: {
    mode: import('../../../../packages/contracts/src/index.ts').SpeechBubbleMode;
  };
}

export interface ConversationSidebarLayoutState {
  visible: boolean;
  mode: 'sidecar' | 'overlay';
  preferredSide: 'left' | 'right';
  side: 'left' | 'right';
  extentDip: number;
  avatarViewport: {
    x: number;
    width: number;
  };
}

export interface DesktopAgentRolesConfig {
  char: {
    provider: string;
    promptProfile: string;
    maxConcurrency: number;
    requestTimeoutMs: number;
    personaRevision: number;
    persona: import('../../../../packages/conversation-runtime/src/index.ts').PersonaProjection;
    applicationFallbackText: string;
  };
  router: {
    provider: string;
    promptProfile: string;
    requestTimeoutMs: number;
    profileRevision: number;
    profile: {
      name: string;
      instructions: string[];
    };
    temperature: number;
    autoSubmitMinConfidence: number;
    autoSubmitMinMargin: number;
    maxTimelineEntries: number;
    maxCandidates: number;
  };
}

export interface DesktopPerformanceInferenceConfig {
  enabled: boolean;
  operational: boolean;
  lifecycle: 'external' | 'managed';
  phase: 'disabled' | 'starting' | 'ready' | 'stopping' | 'restarting' | 'failed';
  processId: number | null;
  lastError: string | null;
  provider: string;
  baseUrl: string;
  model?: string;
  timeoutMs: number;
  maxOutputTokens: number;
  temperature: number;
  fallbackToRules: boolean;
}

export type DesktopCursorIntent = 'default' | 'pointer' | 'move';

export interface PointerPresentation {
  passthrough: boolean;
  cursor: DesktopCursorIntent;
}

export interface DesktopCharApi {
  platform: string;
  ready(): Promise<DesktopWindowState>;
  getWindowState(): Promise<DesktopWindowState>;
  beginDrag(point: DesktopPoint): Promise<DesktopWindowState>;
  dragTo(point: DesktopPoint): void;
  endDrag(): Promise<DesktopWindowState>;
  setPointerPresentation(presentation: PointerPresentation): void;
  runWindowCommand(command: DesktopWindowCommand): void;
  publishAgentState(state: AgentRuntimeState): void;
  requestConversationReply(
    agentId: string,
    task: import('../../../../packages/conversation-runtime/src/index.ts').CharReplyTask,
  ): Promise<import('../../../../packages/conversation-runtime/src/index.ts').CharReplyResult>;
  cancelConversationReply(agentId: string, taskId: string, attemptId: string): void;
  getConversationAgentState(): Promise<ConversationAgentState>;
  requestRouteDecision(
    request: import('../../../../packages/interaction-routing/src/index.ts').RouterAgentRequest,
  ): Promise<import('../../../../packages/interaction-routing/src/index.ts').RouterAgentResult>;
  cancelRouteDecision(messageId: string, visibleContextRevision: number): void;
  getRouterAgentState(): Promise<RouterAgentState>;
  getTaskManagerState(): Promise<TaskManagerState>;
  setTaskManagerEnabled(enabled: boolean): Promise<TaskManagerState>;
  submitTaskManagerCommand(command: TaskManagerCommand): Promise<TaskManagerCommandState>;
  getConversationSessionsState(): Promise<ConversationSessionRegistryState>;
  createManagedConversationSession(request: { title?: string }): Promise<ConversationSessionState>;
  bindExternalConversationSession(
    request: { sourceSessionId: string },
  ): Promise<ConversationSessionState>;
  reviewConversationSession(sessionId: string): Promise<ConversationSessionReviewState>;
  closeConversationSession(sessionId: string): Promise<ConversationSessionCloseResult>;
  submitConversationSessionCommand(
    command: TaskManagerCommand,
  ): Promise<ConversationSessionCommandState>;
  setConversationSidebarVisible(visible: boolean): Promise<ConversationSidebarLayoutState>;
  listTtsMcpTools(): Promise<McpToolDescriptor[]>;
  callTtsMcpTool(name: string, args: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<McpCallToolResult>;
  getMcpServicesState(): Promise<McpServicesState>;
  setMcpServiceEnabled(service: McpServiceId, enabled: boolean): Promise<McpServicesState>;
  reloadDesktopConfig(): Promise<McpServicesState>;
  setPerformanceInferenceEnabled(enabled: boolean): Promise<DesktopWindowState>;
  testMcpService(service: McpServiceId): Promise<McpServiceTest>;
  testAllMcpServices(): Promise<Record<McpServiceId, McpServiceTest>>;
  onMcpServicesState(callback: (state: McpServicesState) => void): () => void;
  onDesktopConfigState(callback: (state: DesktopWindowState) => void): () => void;
  onConversationAgentState(callback: (state: ConversationAgentState) => void): () => void;
  onRouterAgentState(callback: (state: RouterAgentState) => void): () => void;
  onTaskManagerState(callback: (state: TaskManagerState) => void): () => void;
  onConversationSessionsState(
    callback: (state: ConversationSessionRegistryState) => void,
  ): () => void;
  onConversationSessionEvent(
    callback: (event: ConversationSessionEventState) => void,
  ): () => void;
  onConversationSidebarState(
    callback: (state: ConversationSidebarLayoutState) => void,
  ): () => void;
  onAgentCommand(callback: (command: AgentCommand) => void): () => void;
  onBoundsChanged(callback: (bounds: DesktopRectangle) => void): () => void;
  onCursorPoint(callback: (point: DesktopPoint) => void): () => void;
}

export type DesktopWindowCommand = 'restore-default-position' | 'hide-avatar' | 'show-avatar' | 'quit';

export interface RouterAgentState {
  phase: 'standby' | 'active' | 'ready' | 'closed';
  active: number;
  provider: string;
  adapter: 'codex-app-server' | 'openai-compatible';
  requestTimeoutMs: number;
  promptProfile: string;
  profileRevision: number;
  lastDecisionAt: string | null;
  lastResult: import('../../../../packages/interaction-routing/src/index.ts').RouterAgentResult | null;
  lastDecisionSource: 'high-confidence' | 'provider' | null;
  lastDecisionLatencyMs: number | null;
  lastError: string | null;
}

export interface ConversationAgentActivityState {
  activityId: string;
  logicalAgentId: string;
  providerKind: 'managed';
  providerAgentId: string;
  providerInstanceId: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  input: string;
  reply: string | null;
  diagnostics: Array<{
    stage: string;
    at: string;
    detail: string;
  }>;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface ConversationAgentState {
  maxConcurrency: number;
  managed: {
    phase: 'standby' | 'active' | 'ready' | 'stopping';
    active: number;
    requestTimeoutMs: number;
  };
  activities: ConversationAgentActivityState[];
}

export type TaskManagerPhase =
  | 'disabled'
  | 'standby'
  | 'connecting'
  | 'ready'
  | 'degraded'
  | 'reconnecting'
  | 'closed';

export interface TaskManagerSessionState {
  sessionId: string;
  state: 'running' | 'exited' | 'closed' | 'stale';
  monitorState: 'pending' | 'observed' | 'unreadable' | 'closed';
  agentState: 'waiting_input' | 'active' | 'idle_unknown' | 'unknown' | 'closed';
  agentStateSource?: 'codex_rollout' | 'terminal';
  agentStateChangedAtUtc?: string;
  turnRevision?: number;
  submissionId?: string;
  activeSubmissionId?: string;
  completionRevision?: number;
  title?: string;
  workDir?: string;
  lastVisibleLine?: string;
  lastScreenChangedAtUtc?: string;
}

export interface TaskManagerEventState {
  sourceInstanceId: string;
  eventId: string;
  cursor: number;
  sessionId: string;
  type:
    | 'session-changed'
    | 'external-turn-completed'
    | 'task-completed'
    | 'task-failed'
    | 'task-unavailable';
  observedAtMs: number;
  status: string;
  submissionGeneration?: number;
  externalTurnSequence?: number;
  commandId?: string;
  sourceHash?: string;
  sourceRevision?: string;
  agentStateSource?: 'codex_rollout' | 'terminal';
  turnRevision?: number;
  submissionId?: string;
  activeSubmissionId?: string;
  completionRevision?: number;
  title?: string;
  lastVisibleLine?: string;
  visibleTextTail?: string;
  latestReply?: string;
  resultArtifactPath?: string;
  openArtifactOnCompletion?: boolean;
  error?: string;
}

export interface TaskManagerState {
  enabled: boolean;
  lifecycle: 'managed' | 'external';
  phase: TaskManagerPhase;
  markerPath: string;
  sessionMonitorMarkerPath: string | null;
  processId: number | null;
  reconnectAttempt: number;
  instanceId: string | null;
  cursor: number;
  pendingAckCount: number;
  watchedSessionCount: number;
  lastPollAtMs: number | null;
  lastError: string | null;
  sessions: TaskManagerSessionState[];
  events: TaskManagerEventState[];
}

export interface TaskManagerCommand {
  commandId: string;
  sessionId: string;
  text: string;
  mode: 'submit';
  contextRevision: number;
  resultArtifact?: {
    path: string;
    openOnCompletion: boolean;
  };
}

export interface TaskManagerCommandState extends TaskManagerCommand {
  submissionGeneration: number;
  status:
    | 'submitting'
    | 'observing'
    | 'activation-unconfirmed'
    | 'completed'
    | 'failed'
    | 'unavailable'
    | 'superseded';
  createdAtMs?: number;
  submittedAtMs?: number;
  activationUnconfirmedAtMs?: number;
  completedAtMs?: number;
  error?: string;
}

export type ConversationSessionOwnership = 'managed' | 'external';
export type ConversationSessionRouteStatus =
  | 'waiting-input'
  | 'active'
  | 'idle-unknown'
  | 'unavailable';

export interface ConversationSessionState {
  sessionId: string;
  ownership: ConversationSessionOwnership;
  title: string;
  status: ConversationSessionRouteStatus;
  workDir: string | null;
  createdAtMs: number;
  lastActivityAtMs: number;
  lastResponse: string | null;
  lastError: string | null;
  lastReview: ConversationSessionReviewState | null;
  recordCount: number;
  droppedRecordCount: number;
  threadId?: string;
  sourceSessionId?: string;
}

export interface ExternalConversationCandidateState {
  sourceSessionId: string;
  title: string;
  workDir: string | null;
  status: ConversationSessionRouteStatus;
}

export interface ConversationSessionRegistryState {
  phase: 'ready' | 'closing' | 'closed';
  revision: number;
  persistence: 'memory-only';
  sessions: ConversationSessionState[];
  availableExternalSessions: ExternalConversationCandidateState[];
}

export interface ConversationSessionEventState {
  eventId: string;
  sessionId: string;
  type: 'task-completed' | 'task-failed';
  observedAtMs: number;
  status: 'completed' | 'failed';
  title: string;
  lastVisibleLine?: string;
  visibleTextTail?: string;
  latestReply?: string;
  error?: string;
}

export interface ConversationSessionRecordState {
  recordId: string;
  direction: 'outbound' | 'inbound' | 'status';
  source: 'desktop-char' | 'task-manager' | 'managed';
  atMs: number;
  text: string;
}

export interface ConversationSessionReviewState {
  schemaVersion: 'desktop-char.conversation-session-review.v1';
  reviewId: string;
  capturedAtMs: number;
  session: {
    sessionId: string;
    ownership: ConversationSessionOwnership;
    title: string;
    status: ConversationSessionRouteStatus;
    registeredAtMs: number;
    lastActivityAtMs: number;
    workDir?: string;
  };
  source: {
    kind: 'session-monitor' | 'managed-registry' | 'cached';
    stale: boolean;
    completion: 'complete' | 'in-progress' | 'unknown' | 'unavailable';
    revision?: string;
    observedAtUtc?: string;
    error?: string;
  };
  current: {
    lastVisibleLine?: string;
    visibleTextTail?: string;
    latestReply?: string;
  };
  records: ConversationSessionRecordState[];
  droppedRecordCount: number;
}

export interface ConversationSessionCommandState extends TaskManagerCommand {
  ownership: ConversationSessionOwnership;
  status: TaskManagerCommandState['status'] | 'active';
  sourceSessionId?: string;
  delivery?: 'turn-started' | 'steered';
  turnId?: string;
  submissionGeneration?: number;
  createdAtMs?: number;
  submittedAtMs?: number;
  completedAtMs?: number;
  error?: string;
}

export interface ConversationSessionCloseResult {
  sessionId: string;
  action: 'archived' | 'disconnected';
}

export type AgentCommand =
  | { type: 'performance.submit'; plan: import('../../../../packages/contracts/src/index.ts').PerformancePlan }
  | { type: 'performance.interrupt' };

export interface AgentRuntimeState {
  ready: boolean;
  snapshot: import('../../../../packages/contracts/src/index.ts').AvatarSnapshot | null;
}

export interface DesktopTtsConfig {
  lifecycle: 'external' | 'managed';
  profile?: string;
  provider: string | null;
  mcpUrl: string;
  timeoutMs: number;
  format: import('../../../../packages/tts-mcp-adapter/src/index.ts').TtsAudioFormat;
  testFixtures: string[];
  fallbackCharactersPerSecond: number;
  voice?: string;
  rate?: number;
}

export type McpServiceId = 'tts' | 'character';
export type McpServicePhase = 'disabled' | 'starting' | 'ready' | 'degraded' | 'reload-pending'
  | 'reloading' | 'reconnecting' | 'stopping' | 'failed';

export interface McpServiceTest {
  status: 'passed' | 'failed';
  testedAt: string;
  latencyMs: number;
  details: string;
}

export interface McpServiceState {
  id: McpServiceId;
  desiredEnabled: boolean;
  phase: McpServicePhase;
  provider: string | null;
  processId: number | null;
  capabilities: Record<string, unknown> | null;
  endpoint: string | null;
  configRevision: number;
  reconnectAttempt: number;
  nextReconnectAt: string | null;
  lastError: string | null;
  lastTest: McpServiceTest | null;
  runtimeConfig?: DesktopTtsConfig | null;
}

export interface McpServicesState {
  config: {
    path: string;
    exists: boolean;
    revision: number;
    status: 'loading' | 'ready' | 'error';
    loadedAt: string | null;
    error: string | null;
  };
  tts: McpServiceState;
  character: McpServiceState;
}

export type McpToolDescriptor = import('../../../../packages/tts-mcp-adapter/src/index.ts').McpToolDescriptor;
export type McpCallToolResult = import('../../../../packages/tts-mcp-adapter/src/index.ts').McpCallToolResult;

declare global {
  interface Window {
    desktopChar?: DesktopCharApi;
  }
}
