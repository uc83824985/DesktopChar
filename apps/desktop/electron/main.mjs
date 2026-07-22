import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, protocol, screen, Tray } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_AVATAR_WINDOW_SIZE,
  applyDragAvatarBounds,
  describePointerPresentationChange,
  dragAvatarBounds,
  initialAvatarBounds,
  isScreenPoint,
  parseDragHoldDelayMs,
  parseLoopbackDevUrl,
} from './window-policy.mjs';
import { createAgentHttpServer, parseAgentPort } from './agent-http-server.mjs';
import { createNativeCursorRefresh } from './cursor-refresh.mjs';
import { createNativeWindowPosition } from './native-window-position.mjs';
import { createMcpServicesController } from './mcp-services-controller.mjs';
import {
  nextAvatarVisibility,
  trayIconRepresentations,
  trayVisibilityLabel,
} from './tray-policy.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(directory, '../dist');
const devUrl = parseLoopbackDevUrl(process.env.DESKTOP_CHAR_DEV_URL);
const dragHoldDelayMs = parseDragHoldDelayMs(process.env.DESKTOP_CHAR_DRAG_HOLD_DELAY_MS);
const rawConsoleLog = console.log.bind(console);
const rawConsoleError = console.error.bind(console);
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
};

function safeLog(...args) {
  try { rawConsoleLog(...args); }
  catch (error) {
    if (!isBrokenOutputPipe(error)) throw error;
  }
}

function safeError(...args) {
  try { rawConsoleError(...args); }
  catch (error) {
    if (!isBrokenOutputPipe(error)) throw error;
  }
}

function isBrokenOutputPipe(error) {
  return error && typeof error === 'object'
    && (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED');
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'desktop-char',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
}]);

let avatarWindow = null;
let desktopTray = null;
let trayIconScaleFactors = [];
let avatarVisibilityIntent = false;
let avatarPresentationPhase = 'hidden';
let avatarPresentationRequestId = 0;
let avatarPresentationTimer;
let avatarFrameSubscriptionActive = false;
let avatarBounds = null;
let cursorTimer;
let cursorRefreshTimer;
let dragState = null;
let pointerPresentation = { passthrough: true, cursor: 'default' };
let pointerPresentationApplied = false;
const nativeCursorRefresh = createNativeCursorRefresh();
const nativeWindowPosition = createNativeWindowPosition();
const requestedDragWindowApi = process.env.DESKTOP_CHAR_DRAG_WINDOW_API ?? 'auto';
if (!['auto', 'native', 'setBounds'].includes(requestedDragWindowApi)) {
  throw new TypeError('DESKTOP_CHAR_DRAG_WINDOW_API must be auto, native, or setBounds');
}
const dragWindowApi = requestedDragWindowApi !== 'setBounds' && nativeWindowPosition.available
  ? 'native-set-window-pos'
  : 'setBounds';
const lipSyncGain = environmentNumber('DESKTOP_CHAR_LIP_SYNC_GAIN', 2.5);
const ttsContext = {
  requestedMode: 'local',
  activeMode: 'disabled',
  provider: 'desktop-char-local-tts',
  mcpTool: 'tts_open_stream',
  mcpCancelTool: 'tts_cancel_synthesis',
  transport: null,
};
let lastMcpServicesLogKey = '';
const mcpServices = createMcpServicesController({
  env: process.env,
  version: app.getVersion(),
  ttsContext,
  onCharacterCommand(command) { avatarWindow?.webContents.send(channels.agentCommand, command); },
  onStateChanged(state) {
    avatarWindow?.webContents.send(channels.mcpServicesState, state);
    const key = JSON.stringify([
      state.config.revision, state.config.status,
      state.tts.phase, state.tts.endpoint, state.tts.reconnectAttempt, state.tts.lastError,
      state.character.phase, state.character.endpoint, state.character.reconnectAttempt, state.character.lastError,
    ]);
    if (key === lastMcpServicesLogKey) return;
    lastMcpServicesLogKey = key;
    safeLog('[mcp-services]', {
      config: { revision: state.config.revision, status: state.config.status, error: state.config.error },
      tts: serviceLogFacts(state.tts),
      character: serviceLogFacts(state.character),
    });
  },
});
const agentServer = createAgentHttpServer({
  host: '127.0.0.1',
  port: parseAgentPort(process.env.DESKTOP_CHAR_AGENT_PORT),
  ttsContext,
  onCommand(command) { avatarWindow?.webContents.send(channels.agentCommand, command); },
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else {
  app.on('second-instance', () => setAvatarVisibility(true));
  app.whenReady().then(async () => {
    await mcpServices.start();
    if (!devUrl) registerRendererProtocol();
    registerIpc();
    createAvatarWindow();
    createDesktopTray();
    const address = await agentServer.listen();
    safeLog(`[agent-http] listening on http://127.0.0.1:${address.port}`);
  }).catch(error => {
    safeError('[desktop-char] startup failed', error);
    app.quit();
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (cursorTimer) clearInterval(cursorTimer);
  if (cursorRefreshTimer) clearTimeout(cursorRefreshTimer);
  cancelAvatarPresentation();
  desktopTray?.destroy();
  desktopTray = null;
  void agentServer.close().catch(() => {});
  void mcpServices.close().catch(() => {});
});

function registerRendererProtocol() {
  protocol.handle('desktop-char', request => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const relativeRequest = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    const filePath = path.resolve(rendererRoot, relativeRequest);
    const relativePath = path.relative(rendererRoot, filePath);
    const safe = relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
    return safe
      ? net.fetch(pathToFileURL(filePath).toString())
      : new Response('Invalid path', { status: 400 });
  });
}

function createAvatarWindow() {
  const primary = screen.getPrimaryDisplay();
  const bounds = initialAvatarBounds(primary.workArea, DEFAULT_AVATAR_WINDOW_SIZE);
  avatarBounds = { ...bounds };
  avatarWindow = new BrowserWindow({
    ...bounds,
    title: 'DesktopChar',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(directory, 'preload.cjs'),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  avatarWindow.setOpacity(0);
  avatarWindow.setAlwaysOnTop(true);
  applyPointerPresentation({ passthrough: true, cursor: 'default' });
  avatarWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  avatarWindow.webContents.on('will-navigate', event => event.preventDefault());
  avatarWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 3) safeError('[renderer-console-error]', { message, line, sourceId });
  });
  avatarWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    safeError('[renderer-load-failed]', { errorCode, errorDescription, validatedURL });
  });
  avatarWindow.webContents.on('render-process-gone', (_event, details) => {
    safeError('[renderer-process-gone]', details);
  });
  avatarWindow.on('move', publishBounds);
  avatarWindow.on('resize', publishBounds);
  avatarWindow.on('show', updateTrayMenu);
  avatarWindow.on('hide', updateTrayMenu);
  avatarWindow.on('closed', () => {
    cancelAvatarPresentation();
    avatarWindow = null;
  });
  void avatarWindow.loadURL(devUrl ?? 'desktop-char://app/');

  cursorTimer = setInterval(() => {
    if (!avatarWindow || avatarWindow.isDestroyed()) return;
    avatarWindow.webContents.send(channels.cursorPoint, screen.getCursorScreenPoint());
  }, 33);
}

function createDesktopTray() {
  const iconPath = path.join(directory, 'assets', 'TrayIcon.png');
  const source = nativeImage.createFromPath(iconPath);
  if (source.isEmpty()) throw new Error('Desktop tray icon failed to load');
  const icon = nativeImage.createEmpty();
  for (const { scaleFactor, pixelSize } of trayIconRepresentations()) {
    const representation = source.resize({
      width: pixelSize,
      height: pixelSize,
      quality: 'best',
    });
    icon.addRepresentation({ scaleFactor, dataURL: representation.toDataURL() });
  }
  if (icon.isEmpty()) throw new Error('Desktop tray icon representations failed to build');
  trayIconScaleFactors = icon.getScaleFactors();
  desktopTray = new Tray(icon);
  desktopTray.setToolTip('DesktopChar');
  desktopTray.on('click', () => setAvatarVisibility(nextAvatarVisibility(avatarVisibilityIntent)));
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!desktopTray) return;
  const avatarVisible = avatarVisibilityIntent;
  desktopTray.setContextMenu(Menu.buildFromTemplate([
    { label: trayVisibilityLabel(avatarVisible), click: () => setAvatarVisibility(!avatarVisible) },
    { label: '恢复默认位置', click: restoreDefaultPosition },
    { type: 'separator' },
    { label: '退出 DesktopChar', click: () => app.quit() },
  ]));
}

function setAvatarVisibility(visible) {
  if (!avatarWindow || avatarWindow.isDestroyed()) return;
  if (visible === avatarVisibilityIntent && avatarPresentationPhase !== 'warming') return;
  avatarVisibilityIntent = visible;
  dragState = null;
  if (visible) {
    const requestId = ++avatarPresentationRequestId;
    cancelAvatarPresentation();
    avatarPresentationPhase = 'warming';
    avatarWindow.setOpacity(0);
    avatarWindow.showInactive();
    if (!avatarWindow.isAlwaysOnTop()) avatarWindow.setAlwaysOnTop(true);
    avatarFrameSubscriptionActive = true;
    avatarWindow.webContents.beginFrameSubscription(false, image => {
      if (image.isEmpty()) return;
      completeAvatarPresentation(requestId, 'presented');
    });
    avatarWindow.webContents.invalidate();
    avatarPresentationTimer = setTimeout(() => {
      safeError('[avatar-visibility] presentation timed out; revealing fallback frame', { requestId });
      completeAvatarPresentation(requestId, 'timeout');
    }, 1_000);
  }
  else {
    ++avatarPresentationRequestId;
    cancelAvatarPresentation();
    avatarPresentationPhase = 'hidden';
    avatarWindow.setOpacity(0);
    avatarWindow.hide();
  }
  updateTrayMenu();
}

function completeAvatarPresentation(requestId, source) {
  if (!avatarWindow || avatarWindow.isDestroyed()
    || requestId !== avatarPresentationRequestId || !avatarVisibilityIntent) return;
  cancelAvatarPresentation();
  avatarWindow.setOpacity(1);
  avatarPresentationPhase = 'visible';
  updateTrayMenu();
  if (source === 'timeout') avatarWindow.webContents.invalidate();
}

function cancelAvatarPresentation() {
  if (avatarPresentationTimer) clearTimeout(avatarPresentationTimer);
  avatarPresentationTimer = undefined;
  if (avatarFrameSubscriptionActive && avatarWindow && !avatarWindow.isDestroyed()) {
    avatarWindow.webContents.endFrameSubscription();
  }
  avatarFrameSubscriptionActive = false;
}

function registerIpc() {
  ipcMain.handle(channels.ready, event => {
    requireAvatarSender(event);
    setAvatarVisibility(true);
    return windowState();
  });
  ipcMain.handle(channels.getState, event => {
    requireAvatarSender(event);
    return windowState();
  });
  ipcMain.handle(channels.beginDrag, (event, point) => {
    requireAvatarSender(event);
    if (!isScreenPoint(point)) throw new TypeError('Invalid drag start point');
    // Pointer capture and the renderer CSS cursor already own the drag cursor.
    // A delayed native WM_SETCURSOR refresh here can race the first setBounds.
    applyPointerPresentation({ passthrough: false, cursor: 'move' }, { refreshCursor: false });
    avatarWindow.webContents.invalidate();
    dragState = {
      startPointer: point,
      startBounds: { ...avatarBounds },
      nativeWindowHandle: nativeWindowHandleAddress(avatarWindow.getNativeWindowHandle()),
    };
    return windowState();
  });
  ipcMain.on(channels.dragTo, (event, point) => {
    requireAvatarSender(event);
    if (!dragState || !isScreenPoint(point)) return;
    const display = screen.getDisplayNearestPoint(point);
    const nextBounds = dragAvatarBounds(
      dragState.startBounds,
      dragState.startPointer,
      point,
      display.workArea,
    );
    const currentBounds = avatarWindow.getBounds();
    if (currentBounds.x === nextBounds.x && currentBounds.y === nextBounds.y) return;
    const previousAvatarBounds = avatarBounds;
    avatarBounds = { ...nextBounds };
    let nativeResult;
    let submitted;
    let nativePoint;
    if (dragWindowApi === 'native-set-window-pos') {
      nativePoint = screen.dipToScreenPoint({ x: nextBounds.x, y: nextBounds.y });
      nativeResult = nativeWindowPosition.move(dragState.nativeWindowHandle, nativePoint);
      submitted = nativeResult.moved;
      if (!submitted) {
        safeError('[native-window-position] failed; falling back to setBounds', {
          nativePoint, ...nativeResult,
        });
        submitted = applyDragAvatarBounds(avatarWindow, nextBounds);
      }
    }
    else submitted = applyDragAvatarBounds(avatarWindow, nextBounds);
    if (!submitted) {
      avatarBounds = previousAvatarBounds;
      return;
    }
  });
  ipcMain.handle(channels.endDrag, event => {
    requireAvatarSender(event);
    dragState = null;
    return windowState();
  });
  ipcMain.on(channels.setPointerPresentation, (event, presentation) => {
    requireAvatarSender(event);
    if (isPointerPresentation(presentation) && !dragState) applyPointerPresentation(presentation);
  });
  ipcMain.on(channels.windowCommand, (event, command) => {
    requireAvatarSender(event);
    if (command === 'restore-default-position') restoreDefaultPosition();
    else if (command === 'hide-avatar') setAvatarVisibility(false);
    else if (command === 'show-avatar') setAvatarVisibility(true);
    else if (command === 'quit') app.quit();
  });
  ipcMain.on(channels.agentState, (event, state) => {
    requireAvatarSender(event);
    if (!isAgentState(state)) return;
    agentServer.updateState(state);
    mcpServices.updateAvatarState(state);
  });
  ipcMain.handle(channels.mcpListTools, async event => {
    requireAvatarSender(event);
    const tools = await mcpServices.listTtsTools({ timeoutMs: 10_000 });
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    }));
  });
  ipcMain.handle(channels.mcpCallTool, async (event, name, args, options) => {
    requireAvatarSender(event);
    return mcpServices.callTtsTool(name, args, { timeoutMs: options?.timeoutMs ?? 30_000 });
  });
  ipcMain.handle(channels.mcpServicesGet, event => {
    requireAvatarSender(event);
    return mcpServices.snapshot();
  });
  ipcMain.handle(channels.mcpServicesSetEnabled, (event, service, enabled) => {
    requireAvatarSender(event);
    return mcpServices.setEnabled(service, enabled);
  });
  ipcMain.handle(channels.mcpServicesReload, event => {
    requireAvatarSender(event);
    return mcpServices.reload('ui');
  });
  ipcMain.handle(channels.mcpServicesTest, (event, service) => {
    requireAvatarSender(event);
    return mcpServices.test(service);
  });
  ipcMain.handle(channels.mcpServicesTestAll, event => {
    requireAvatarSender(event);
    return mcpServices.testAll();
  });
}

function applyPointerPresentation(presentation, options = {}) {
  const change = describePointerPresentationChange(
    pointerPresentation,
    presentation,
    pointerPresentationApplied,
  );
  pointerPresentation = { ...presentation };
  pointerPresentationApplied = true;
  if (change.passthroughChanged) {
    avatarWindow?.setIgnoreMouseEvents(presentation.passthrough, { forward: presentation.passthrough });
  }
  if (options.refreshCursor === false && cursorRefreshTimer) {
    clearTimeout(cursorRefreshTimer);
    cursorRefreshTimer = undefined;
  }
  if (change.refreshCursor && options.refreshCursor !== false && process.platform === 'win32') {
    if (cursorRefreshTimer) clearTimeout(cursorRefreshTimer);
    cursorRefreshTimer = setTimeout(() => {
      cursorRefreshTimer = undefined;
      const current = { ...pointerPresentation };
      const focused = avatarWindow?.isFocused() ?? false;
      const windowHandle = current.passthrough || !avatarWindow
        ? undefined
        : nativeWindowHandleAddress(avatarWindow.getNativeWindowHandle());
      const result = nativeCursorRefresh.refresh({
        cursor: current.cursor,
        windowHandle,
        refreshFrame: change.enteredInteractive && !current.passthrough,
        nudgeCursor: change.enteredInteractive && !current.passthrough && !focused,
      });
      if (!result.refreshed) safeError('[cursor-refresh] failed', {
        presentation: current, available: nativeCursorRefresh.available, focused, ...result,
      });
    }, 16);
  }
}

function nativeWindowHandleAddress(buffer) {
  return buffer.length >= 8 ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0));
}

function isPointerPresentation(value) {
  return Boolean(value)
    && typeof value === 'object'
    && typeof value.passthrough === 'boolean'
    && ['default', 'pointer', 'move'].includes(value.cursor)
    && (!value.passthrough || value.cursor === 'default');
}

function restoreDefaultPosition() {
  if (!avatarWindow) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { width, height } = avatarBounds;
  avatarBounds = initialAvatarBounds(display.workArea, { width, height });
  avatarWindow.setBounds(avatarBounds);
  publishBounds();
}

function publishBounds() {
  if (!avatarWindow || avatarWindow.isDestroyed()) return;
  avatarWindow.webContents.send(channels.boundsChanged, { ...avatarBounds });
}

function windowState() {
  if (!avatarWindow) throw new Error('Avatar window is not available');
  return {
    bounds: { ...avatarBounds },
    mousePassthrough: pointerPresentation.passthrough,
    pointerPresentation: { ...pointerPresentation },
    alwaysOnTop: avatarWindow.isAlwaysOnTop(),
    visible: avatarVisibilityIntent,
    presentation: {
      phase: avatarPresentationPhase,
      requestId: avatarPresentationRequestId,
      opacity: avatarWindow.getOpacity(),
      backgroundThrottling: avatarWindow.webContents.getBackgroundThrottling(),
    },
    tray: { available: Boolean(desktopTray), iconScaleFactors: [...trayIconScaleFactors] },
    interaction: { dragHoldDelayMs, dragWindowApi },
    lipSync: { gain: lipSyncGain },
    tts: mcpServices.currentTtsConfig(),
    mcpServices: mcpServices.snapshot(),
  };
}

function requireAvatarSender(event) {
  if (!avatarWindow || event.sender !== avatarWindow.webContents) throw new Error('Rejected untrusted IPC sender');
}

function isAgentState(value) {
  return value && typeof value === 'object' && typeof value.ready === 'boolean'
    && (value.snapshot === null || (typeof value.snapshot === 'object' && typeof value.snapshot.state === 'string'));
}

function environmentNumber(name, fallback, allowZero = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new TypeError(`${name} must be ${allowZero ? 'non-negative' : 'positive'}`);
  }
  return parsed;
}

function serviceLogFacts(state) {
  return {
    desiredEnabled: state.desiredEnabled,
    phase: state.phase,
    endpoint: state.endpoint,
    reconnectAttempt: state.reconnectAttempt,
    lastError: state.lastError,
  };
}
