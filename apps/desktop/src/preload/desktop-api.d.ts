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
  alwaysOnTop: boolean;
}

export interface DesktopCharApi {
  platform: string;
  ready(): Promise<DesktopWindowState>;
  getWindowState(): Promise<DesktopWindowState>;
  beginDrag(point: DesktopPoint): Promise<DesktopWindowState>;
  dragTo(point: DesktopPoint): void;
  endDrag(): Promise<DesktopWindowState>;
  setMousePassthrough(passthrough: boolean): void;
  showContextMenu(): void;
  publishAgentState(state: AgentRuntimeState): void;
  onAgentCommand(callback: (command: AgentCommand) => void): () => void;
  onBoundsChanged(callback: (bounds: DesktopRectangle) => void): () => void;
  onCursorPoint(callback: (point: DesktopPoint) => void): () => void;
}

export type AgentCommand =
  | { type: 'performance.submit'; plan: import('../../../../packages/contracts/src/index.ts').PerformancePlan }
  | { type: 'performance.interrupt' };

export interface AgentRuntimeState {
  ready: boolean;
  snapshot: import('../../../../packages/contracts/src/index.ts').AvatarSnapshot | null;
}

declare global {
  interface Window {
    desktopChar?: DesktopCharApi;
  }
}
