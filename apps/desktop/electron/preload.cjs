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
  windowCommand: 'avatar-window:command',
  agentCommand: 'agent-http:command',
  agentState: 'agent-http:state',
  mcpListTools: 'tts-mcp:list-tools',
  mcpCallTool: 'tts-mcp:call-tool',
  mcpServicesGet: 'mcp-services:get-state',
  mcpServicesSetEnabled: 'mcp-services:set-enabled',
  mcpServicesReload: 'mcp-services:reload',
  mcpServicesTest: 'mcp-services:test',
  mcpServicesTestAll: 'mcp-services:test-all',
  mcpServicesState: 'mcp-services:state',
  desktopConfigState: 'desktop-config:state',
};

contextBridge.exposeInMainWorld('desktopChar', {
  platform: process.platform,
  ready: () => ipcRenderer.invoke(channels.ready),
  getWindowState: () => ipcRenderer.invoke(channels.getState),
  beginDrag: point => ipcRenderer.invoke(channels.beginDrag, point),
  dragTo: point => ipcRenderer.send(channels.dragTo, point),
  endDrag: () => ipcRenderer.invoke(channels.endDrag),
  setPointerPresentation: presentation => ipcRenderer.send(channels.setPointerPresentation, presentation),
  runWindowCommand: command => ipcRenderer.send(channels.windowCommand, command),
  publishAgentState: state => ipcRenderer.send(channels.agentState, state),
  listTtsMcpTools: () => ipcRenderer.invoke(channels.mcpListTools),
  callTtsMcpTool: (name, args, options) => ipcRenderer.invoke(channels.mcpCallTool, name, args, options),
  getMcpServicesState: () => ipcRenderer.invoke(channels.mcpServicesGet),
  setMcpServiceEnabled: (service, enabled) => ipcRenderer.invoke(channels.mcpServicesSetEnabled, service, enabled),
  reloadMcpServices: () => ipcRenderer.invoke(channels.mcpServicesReload),
  testMcpService: service => ipcRenderer.invoke(channels.mcpServicesTest, service),
  testAllMcpServices: () => ipcRenderer.invoke(channels.mcpServicesTestAll),
  onMcpServicesState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on(channels.mcpServicesState, listener);
    return () => ipcRenderer.removeListener(channels.mcpServicesState, listener);
  },
  onDesktopConfigState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on(channels.desktopConfigState, listener);
    return () => ipcRenderer.removeListener(channels.desktopConfigState, listener);
  },
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
