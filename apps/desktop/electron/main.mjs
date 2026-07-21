import { app, BrowserWindow, ipcMain, net, protocol, screen } from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
let avatarBounds = null;
let cursorTimer;
let cursorRefreshTimer;
let dragState = null;
let pointerPresentation = { passthrough: true, cursor: 'default' };
let pointerPresentationApplied = false;
let mcpSession = null;
const nativeCursorRefresh = createNativeCursorRefresh();
const nativeWindowPosition = createNativeWindowPosition();
const requestedDragWindowApi = process.env.DESKTOP_CHAR_DRAG_WINDOW_API ?? 'auto';
if (!['auto', 'native', 'setBounds'].includes(requestedDragWindowApi)) {
  throw new TypeError('DESKTOP_CHAR_DRAG_WINDOW_API must be auto, native, or setBounds');
}
const dragWindowApi = requestedDragWindowApi !== 'setBounds' && nativeWindowPosition.available
  ? 'native-set-window-pos'
  : 'setBounds';
const ttsMode = process.env.DESKTOP_CHAR_TTS_MODE ?? 'mock';
const ttsMcpUrl = process.env.DESKTOP_CHAR_TTS_MCP_URL ?? 'http://127.0.0.1:8766/mcp';
const agentServer = createAgentHttpServer({
  host: '127.0.0.1',
  port: parseAgentPort(process.env.DESKTOP_CHAR_AGENT_PORT),
  ttsContext: {
    requestedMode: ttsMode,
    activeMode: ttsMode === 'mcp' ? 'mcp' : 'mock',
    mcpTool: process.env.DESKTOP_CHAR_TTS_MCP_TOOL ?? 'tts_open_stream',
    mcpCancelTool: process.env.DESKTOP_CHAR_TTS_MCP_CANCEL_TOOL ?? 'tts_cancel_synthesis',
    transport: ttsMode === 'mcp' ? ttsMcpUrl : 'mock',
  },
  onCommand(command) { avatarWindow?.webContents.send(channels.agentCommand, command); },
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else {
  app.on('second-instance', () => avatarWindow?.showInactive());
  app.whenReady().then(async () => {
    if (!devUrl) registerRendererProtocol();
    registerIpc();
    createAvatarWindow();
    const address = await agentServer.listen();
    safeLog(`[agent-http] listening on http://127.0.0.1:${address.port}`);
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (cursorTimer) clearInterval(cursorTimer);
  if (cursorRefreshTimer) clearTimeout(cursorRefreshTimer);
  void agentServer.close().catch(() => {});
  void closeMcpSession().catch(() => {});
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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
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
  avatarWindow.on('closed', () => { avatarWindow = null; });
  void avatarWindow.loadURL(devUrl ?? 'desktop-char://app/');

  cursorTimer = setInterval(() => {
    if (!avatarWindow || avatarWindow.isDestroyed()) return;
    avatarWindow.webContents.send(channels.cursorPoint, screen.getCursorScreenPoint());
  }, 33);
}

function registerIpc() {
  ipcMain.handle(channels.ready, event => {
    requireAvatarSender(event);
    avatarWindow.showInactive();
    avatarWindow.setAlwaysOnTop(true);
    publishBounds();
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
    else if (command === 'quit') app.quit();
  });
  ipcMain.on(channels.agentState, (event, state) => {
    requireAvatarSender(event);
    if (!isAgentState(state)) return;
    agentServer.updateState(state);
  });
  ipcMain.handle(channels.mcpListTools, async event => {
    requireAvatarSender(event);
    if (ttsMode !== 'mcp') throw new Error('TTS MCP mode is not enabled');
    const session = await getMcpSession();
    const result = await session.client.listTools(undefined, { timeout: 10_000 });
    return result.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    }));
  });
  ipcMain.handle(channels.mcpCallTool, async (event, name, args, options) => {
    requireAvatarSender(event);
    if (ttsMode !== 'mcp') throw new Error('TTS MCP mode is not enabled');
    if (typeof name !== 'string' || !name.trim() || !isPlainRecord(args)) throw new TypeError('Invalid MCP tool call');
    const session = await getMcpSession();
    return session.client.callTool({ name, arguments: args }, undefined, { timeout: options?.timeoutMs ?? 30_000 });
  });
}

async function getMcpSession() {
  if (mcpSession) return mcpSession;
  const transport = new StreamableHTTPClientTransport(new URL(ttsMcpUrl));
  const client = new Client({ name: 'desktop-char', version: app.getVersion() });
  await client.connect(transport);
  mcpSession = { client, transport };
  return mcpSession;
}

async function closeMcpSession() {
  const session = mcpSession;
  mcpSession = null;
  if (!session) return;
  await session.client.close();
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
    interaction: { dragHoldDelayMs, dragWindowApi },
    tts: {
      mode: ttsMode,
      mcpUrl: ttsMcpUrl,
      mcpTool: process.env.DESKTOP_CHAR_TTS_MCP_TOOL ?? 'tts_open_stream',
      mcpCancelTool: process.env.DESKTOP_CHAR_TTS_MCP_CANCEL_TOOL ?? 'tts_cancel_synthesis',
      timeoutMs: Number(process.env.DESKTOP_CHAR_TTS_TIMEOUT_MS ?? 30_000),
      requestIdArgument: process.env.DESKTOP_CHAR_TTS_REQUEST_ID_ARGUMENT ?? 'request_id',
      textArgument: process.env.DESKTOP_CHAR_TTS_TEXT_ARGUMENT ?? 'text',
      format: process.env.DESKTOP_CHAR_TTS_FORMAT ?? 'pcm_s16le',
      voice: process.env.DESKTOP_CHAR_TTS_VOICE,
    },
  };
}

function requireAvatarSender(event) {
  if (!avatarWindow || event.sender !== avatarWindow.webContents) throw new Error('Rejected untrusted IPC sender');
}

function isAgentState(value) {
  return value && typeof value === 'object' && typeof value.ready === 'boolean'
    && (value.snapshot === null || (typeof value.snapshot === 'object' && typeof value.snapshot.state === 'string'));
}

function isPlainRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}
