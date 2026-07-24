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
  character: DesktopCharacterConfig;
  performanceInference: DesktopPerformanceInferenceConfig;
  tts: DesktopTtsConfig;
  mcpServices: McpServicesState;
}

export interface DesktopCharacterConfig {
  profileUrl: string;
}

export interface DesktopInteractionConfig {
  dragHoldDelayMs: number;
  dragWindowApi: 'native-set-window-pos' | 'setBounds';
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
  onAgentCommand(callback: (command: AgentCommand) => void): () => void;
  onBoundsChanged(callback: (bounds: DesktopRectangle) => void): () => void;
  onCursorPoint(callback: (point: DesktopPoint) => void): () => void;
}

export type DesktopWindowCommand = 'restore-default-position' | 'hide-avatar' | 'show-avatar' | 'quit';

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
