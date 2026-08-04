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
  conversationReply: 'conversation:reply',
  conversationCancel: 'conversation:cancel',
  conversationAgentsGet: 'conversation:agents:get-state',
  conversationAgentsState: 'conversation:agents:state',
  routerDecide: 'router-agent:decide',
  routerCancel: 'router-agent:cancel',
  routerGet: 'router-agent:get-state',
  routerState: 'router-agent:state',
  taskManagerGet: 'task-manager:get-state',
  taskManagerSetEnabled: 'task-manager:set-enabled',
  taskManagerSubmit: 'task-manager:submit-command',
  taskManagerState: 'task-manager:state',
  conversationSessionsGet: 'conversation-sessions:get-state',
  conversationSessionsCreate: 'conversation-sessions:create-managed',
  conversationSessionsBind: 'conversation-sessions:bind-external',
  conversationSessionsReview: 'conversation-sessions:review',
  conversationSessionsClose: 'conversation-sessions:close',
  conversationSessionsSubmit: 'conversation-sessions:submit-command',
  conversationSessionsState: 'conversation-sessions:state',
  conversationSessionsEvent: 'conversation-sessions:event',
  conversationSidebarSetVisible: 'conversation-sidebar:set-visible',
  conversationSidebarState: 'conversation-sidebar:state',
  mcpListTools: 'tts-mcp:list-tools',
  mcpCallTool: 'tts-mcp:call-tool',
  mcpServicesGet: 'mcp-services:get-state',
  mcpServicesSetEnabled: 'mcp-services:set-enabled',
  desktopConfigReload: 'desktop-config:reload',
  performanceInferenceSetEnabled: 'performance-inference:set-enabled',
  applicationServicesTestAll: 'application-services:test-all',
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
  requestConversationReply: (agentId, task) => ipcRenderer.invoke(channels.conversationReply, agentId, task),
  cancelConversationReply: (agentId, taskId, attemptId) =>
    ipcRenderer.send(channels.conversationCancel, agentId, taskId, attemptId),
  getConversationAgentState: () => ipcRenderer.invoke(channels.conversationAgentsGet),
  requestRouteDecision: request => ipcRenderer.invoke(channels.routerDecide, request),
  cancelRouteDecision: (messageId, visibleContextRevision) =>
    ipcRenderer.send(channels.routerCancel, messageId, visibleContextRevision),
  getRouterAgentState: () => ipcRenderer.invoke(channels.routerGet),
  getTaskManagerState: () => ipcRenderer.invoke(channels.taskManagerGet),
  setTaskManagerEnabled: enabled =>
    ipcRenderer.invoke(channels.taskManagerSetEnabled, enabled),
  submitTaskManagerCommand: command => ipcRenderer.invoke(channels.taskManagerSubmit, command),
  getConversationSessionsState: () => ipcRenderer.invoke(channels.conversationSessionsGet),
  createManagedConversationSession: request =>
    ipcRenderer.invoke(channels.conversationSessionsCreate, request),
  bindExternalConversationSession: request =>
    ipcRenderer.invoke(channels.conversationSessionsBind, request),
  reviewConversationSession: sessionId =>
    ipcRenderer.invoke(channels.conversationSessionsReview, sessionId),
  closeConversationSession: sessionId =>
    ipcRenderer.invoke(channels.conversationSessionsClose, sessionId),
  submitConversationSessionCommand: command =>
    ipcRenderer.invoke(channels.conversationSessionsSubmit, command),
  setConversationSidebarVisible: visible =>
    ipcRenderer.invoke(channels.conversationSidebarSetVisible, visible),
  listTtsMcpTools: () => ipcRenderer.invoke(channels.mcpListTools),
  callTtsMcpTool: (name, args, options) => ipcRenderer.invoke(channels.mcpCallTool, name, args, options),
  getMcpServicesState: () => ipcRenderer.invoke(channels.mcpServicesGet),
  setMcpServiceEnabled: (service, enabled) => ipcRenderer.invoke(channels.mcpServicesSetEnabled, service, enabled),
  reloadDesktopConfig: () => ipcRenderer.invoke(channels.desktopConfigReload),
  setPerformanceInferenceEnabled: enabled => ipcRenderer.invoke(channels.performanceInferenceSetEnabled, enabled),
  testApplicationServices: () => ipcRenderer.invoke(channels.applicationServicesTestAll),
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
  onConversationAgentState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on(channels.conversationAgentsState, listener);
    return () => ipcRenderer.removeListener(channels.conversationAgentsState, listener);
  },
  onRouterAgentState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on(channels.routerState, listener);
    return () => ipcRenderer.removeListener(channels.routerState, listener);
  },
  onTaskManagerState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on(channels.taskManagerState, listener);
    return () => ipcRenderer.removeListener(channels.taskManagerState, listener);
  },
  onConversationSessionsState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on(channels.conversationSessionsState, listener);
    return () => ipcRenderer.removeListener(channels.conversationSessionsState, listener);
  },
  onConversationSessionEvent(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on(channels.conversationSessionsEvent, listener);
    return () => ipcRenderer.removeListener(channels.conversationSessionsEvent, listener);
  },
  onConversationSidebarState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on(channels.conversationSidebarState, listener);
    return () => ipcRenderer.removeListener(channels.conversationSidebarState, listener);
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
