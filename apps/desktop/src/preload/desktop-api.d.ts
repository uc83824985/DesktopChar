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
  presentation: {
    phase: 'hidden' | 'warming' | 'visible';
    requestId: number;
    opacity: number;
    backgroundThrottling: boolean;
  };
  tray: { available: boolean; iconScaleFactors: number[] };
  interaction: DesktopInteractionConfig;
  lipSync: DesktopLipSyncConfig;
  tts: DesktopTtsConfig;
}

export interface DesktopLipSyncConfig {
  gain: number;
}

export interface DesktopInteractionConfig {
  dragHoldDelayMs: number;
  dragWindowApi: 'native-set-window-pos' | 'setBounds';
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
  mode: 'local' | 'mcp';
  mcpUrl: string;
  mcpTool: string;
  mcpCancelTool: string;
  timeoutMs: number;
  requestIdArgument: string;
  textArgument: string;
  format: import('../../../../packages/tts-mcp-adapter/src/index.ts').TtsAudioFormat;
  voice?: string;
}

export type McpToolDescriptor = import('../../../../packages/tts-mcp-adapter/src/index.ts').McpToolDescriptor;
export type McpCallToolResult = import('../../../../packages/tts-mcp-adapter/src/index.ts').McpCallToolResult;

declare global {
  interface Window {
    desktopChar?: DesktopCharApi;
  }
}
