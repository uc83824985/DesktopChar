import { app, BrowserWindow, ipcMain, Menu, net, protocol, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_AVATAR_WINDOW_SIZE,
  dragAvatarBounds,
  initialAvatarBounds,
  isScreenPoint,
  parseLoopbackDevUrl,
} from './window-policy.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(directory, '../dist');
const devUrl = parseLoopbackDevUrl(process.env.DESKTOP_CHAR_DEV_URL);
const channels = {
  boundsChanged: 'avatar-window:bounds-changed',
  beginDrag: 'avatar-window:begin-drag',
  cursorPoint: 'avatar-window:cursor-point',
  dragTo: 'avatar-window:drag-to',
  endDrag: 'avatar-window:end-drag',
  getState: 'avatar-window:get-state',
  ready: 'avatar-window:ready',
  setMousePassthrough: 'avatar-window:set-mouse-passthrough',
  showContextMenu: 'avatar-window:show-context-menu',
};

protocol.registerSchemesAsPrivileged([{
  scheme: 'desktop-char',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
}]);

let avatarWindow = null;
let cursorTimer;
let dragState = null;
let mousePassthrough = true;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else {
  app.on('second-instance', () => avatarWindow?.showInactive());
  app.whenReady().then(async () => {
    if (!devUrl) registerRendererProtocol();
    registerIpc();
    createAvatarWindow();
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (cursorTimer) clearInterval(cursorTimer); });

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
  avatarWindow.setAlwaysOnTop(true, 'floating');
  setMousePassthrough(true);
  avatarWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  avatarWindow.webContents.on('will-navigate', event => event.preventDefault());
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
    setMousePassthrough(false);
    dragState = { startPointer: point, startBounds: avatarWindow.getBounds() };
    return windowState();
  });
  ipcMain.on(channels.dragTo, (event, point) => {
    requireAvatarSender(event);
    if (!dragState || !isScreenPoint(point)) return;
    const display = screen.getDisplayNearestPoint(point);
    avatarWindow.setBounds(dragAvatarBounds(
      dragState.startBounds,
      dragState.startPointer,
      point,
      display.workArea,
    ));
  });
  ipcMain.handle(channels.endDrag, event => {
    requireAvatarSender(event);
    dragState = null;
    return windowState();
  });
  ipcMain.on(channels.setMousePassthrough, (event, passthrough) => {
    requireAvatarSender(event);
    if (typeof passthrough === 'boolean' && !dragState) setMousePassthrough(passthrough);
  });
  ipcMain.on(channels.showContextMenu, event => {
    requireAvatarSender(event);
    Menu.buildFromTemplate([
      { label: '恢复默认位置', click: restoreDefaultPosition },
      { type: 'separator' },
      { label: '退出 DesktopChar', click: () => app.quit() },
    ]).popup({ window: avatarWindow });
  });
}

function setMousePassthrough(passthrough) {
  mousePassthrough = passthrough;
  avatarWindow?.setIgnoreMouseEvents(passthrough, { forward: passthrough });
}

function restoreDefaultPosition() {
  if (!avatarWindow) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { width, height } = avatarWindow.getBounds();
  avatarWindow.setBounds(initialAvatarBounds(display.workArea, { width, height }));
}

function publishBounds() {
  if (!avatarWindow || avatarWindow.isDestroyed()) return;
  avatarWindow.webContents.send(channels.boundsChanged, avatarWindow.getBounds());
}

function windowState() {
  if (!avatarWindow) throw new Error('Avatar window is not available');
  return { bounds: avatarWindow.getBounds(), mousePassthrough, alwaysOnTop: avatarWindow.isAlwaysOnTop() };
}

function requireAvatarSender(event) {
  if (!avatarWindow || event.sender !== avatarWindow.webContents) throw new Error('Rejected untrusted IPC sender');
}
