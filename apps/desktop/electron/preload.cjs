const { contextBridge, ipcRenderer } = require('electron/renderer');

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

contextBridge.exposeInMainWorld('desktopChar', {
  platform: process.platform,
  ready: () => ipcRenderer.invoke(channels.ready),
  getWindowState: () => ipcRenderer.invoke(channels.getState),
  beginDrag: point => ipcRenderer.invoke(channels.beginDrag, point),
  dragTo: point => ipcRenderer.send(channels.dragTo, point),
  endDrag: () => ipcRenderer.invoke(channels.endDrag),
  setMousePassthrough: passthrough => ipcRenderer.send(channels.setMousePassthrough, passthrough),
  showContextMenu: () => ipcRenderer.send(channels.showContextMenu),
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
