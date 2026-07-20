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
  onBoundsChanged(callback: (bounds: DesktopRectangle) => void): () => void;
  onCursorPoint(callback: (point: DesktopPoint) => void): () => void;
}

declare global {
  interface Window {
    desktopChar?: DesktopCharApi;
  }
}
