# Preload

只暴露白名单 IPC API，不向 renderer 暴露任意 `ipcRenderer` 或 Node.js 能力。

当前桥实现位于 `apps/desktop/electron/preload.cjs`，类型契约位于本目录的 `desktop-api.d.ts`。
