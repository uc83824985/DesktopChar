const { contextBridge, ipcRenderer } = require('electron/renderer');

const channels = {
  boundsChanged: 'avatar-window:bounds-changed',
  beginDrag: 'avatar-window:begin-drag',
  cursorPoint: 'avatar-window:cursor-point',
  dragTo: 'avatar-window:drag-to',
  endDrag: 'avatar-window:end-drag',
  getState: 'avatar-window:get-state',
  ready: 'avatar-window:ready',
  setPointerPresentation: 'avatar-window:set-pointer-presentation',
  showContextMenu: 'avatar-window:show-context-menu',
  agentCommand: 'agent-http:command',
  agentState: 'agent-http:state',
  mcpListTools: 'tts-mcp:list-tools',
  mcpCallTool: 'tts-mcp:call-tool',
};

contextBridge.exposeInMainWorld('desktopChar', {
  platform: process.platform,
  ready: () => ipcRenderer.invoke(channels.ready),
  getWindowState: () => ipcRenderer.invoke(channels.getState),
  beginDrag: point => ipcRenderer.invoke(channels.beginDrag, point),
  dragTo: point => ipcRenderer.send(channels.dragTo, point),
  endDrag: () => ipcRenderer.invoke(channels.endDrag),
  setPointerPresentation: presentation => ipcRenderer.send(channels.setPointerPresentation, presentation),
  showContextMenu: () => ipcRenderer.send(channels.showContextMenu),
  publishAgentState: state => ipcRenderer.send(channels.agentState, state),
  listTtsMcpTools: () => ipcRenderer.invoke(channels.mcpListTools),
  callTtsMcpTool: (name, args, options) => ipcRenderer.invoke(channels.mcpCallTool, name, args, options),
  onAgentCommand(callback) {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on(channels.agentCommand, listener);
    return () => ipcRenderer.removeListener(channels.agentCommand, listener);
  },
  onBoundsChanged(callback) {
    const listener = (_event, bounds) => callback(bounds);
    ipcRenderer.on(channels.boundsChanged, listener);
    return () => ipcRenderer.removeListener(channels.boundsChanged, listener);
  },
  onCursorPoint(callback) {
    const listener = (_event, point) => callback(point);
    ipcRenderer.on(channels.cursorPoint, listener);
    return () => ipcRenderer.removeListener(channels.cursorPoint, listener);
  },
});
