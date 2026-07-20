# 透明桌面悬浮壳设计

## 当前方案

首版使用一个与角色显示区域同尺寸的无边框透明 Electron `BrowserWindow`。角色移动等价于移动原生窗口；窗口自身没有单独的“角色局部坐标”，因此显示位置、点击坐标和原生窗口包围盒不会逐渐漂移。

```text
OS 全局指针（DIP）
        |
 Electron main 每 33ms 采样
        |
        v
renderer: screen point -> window local point -> final-frame pixel coverage
        |                                      |
        | alpha miss                           | visible pixel
        v                                      v
setIgnoreMouseEvents(true, forward)    可点击 / 可拖动角色
桌面收到点击                           UI 只发送 user.avatar-clicked
```

窗口固定透明、置顶、无任务栏图标，默认位于主屏工作区右下角。拖动使用屏幕坐标计算新的 `BrowserWindow` bounds，并将完整窗口限制在距离最近显示器的工作区内。main 在每次 move/resize 后把 bounds 回传 renderer；renderer 只用它做坐标换算和诊断，不自行保存第二份窗口位置状态。

## 点击与拖动

- 指针位置的最终帧像素透明：整个窗口临时进入鼠标穿透，点击落到原桌面应用。
- 指针位置存在可见像素：恢复窗口交互，可左键点击或拖动。
- 位移小于 5 DIP：解释为角色点击，向 Runtime 发送 `user.avatar-clicked`。
- 位移达到 5 DIP：解释为拖动，仅更新原生窗口位置，不修改 Avatar 状态。
- 角色上右键：显示“恢复默认位置 / 退出”原生菜单。

Mao 资源定义的 `Head` 和 `Body` HitArea 现在只用于生成点击事件的语义标签；HitArea 外的头发、衣物等可见像素也可以点击，并回退为 `VisiblePixel` 标签。窗口选取状态以最终 Pixi framebuffer 的 alpha 为准，因而透明纹理和动画后的实际轮廓会实时反映到穿透状态。

### GPU 读取策略

每次只读取鼠标附近 `3×3` 个设备像素，不回读完整 Coverage Buffer：

- WebGL2 每个渲染帧将 `readPixels` 写入最多 36 字节的 `PIXEL_PACK_BUFFER`，插入 `fenceSync` 后立即返回，不等待上一笔完成；后续渲染帧使用非阻塞 `clientWaitSync(..., 0, 0)` 检查多笔 in-flight 请求，fence 完成后按提交帧顺序取回 RGBA。
- WebGL1 不具备 PBO/fence 能力时，降级为同步读取同一小块；最多 36 字节，不会形成完整 framebuffer 回读。
- 坐标发生变化后，旧请求即使稍后完成也不能修改当前选择状态；最新坐标不会因为旧 fence 迟到而丢失。
- renderer 持续 watch 当前坐标：每个渲染帧均提交查询，不再依赖 main 再发送一次鼠标移动，也不被前一笔 fence 的完成时间降低采样率。因此鼠标完全静止时，动作或模型形变造成的 Coverage 变化仍会更新穿透状态。
- `3×3` 足迹取最大 alpha，补偿高 DPI 下一个 CSS 光标位置跨越多个设备子像素的问题；`8/255` 可见阈值排除肉眼近似透明但数值仍为 1～7 的纹理与抗锯齿余量。
- 确认状态使用低延迟非对称防抖：首个可见样本立即进入选中，连续 3 个透明样本才退出（正常 60 Hz 下约 50 ms）。新查询处于 pending 时保持上一个确认状态，短暂的透明边缘不会闪回默认光标。
- 拖动期间停止选取切换，由 renderer pointer capture 和 main drag state 保持窗口可交互。
- `covered` 状态将 canvas 光标切换为 `grab`，拖动期间切换为 `grabbing`；Pixi 写入的内联 cursor 不会覆盖桌面壳反馈。

### Windows 光标刷新

Windows 通常只在真实鼠标移动时向当前目标窗口发送 `WM_SETCURSOR`。动画可以在鼠标静止时改变 Coverage 和窗口穿透状态，此时点击已经命中新目标，但系统光标外观可能仍属于切换前的窗口。Electron 没有公开主动刷新光标或发送 Win32 消息的 API，且 `webContents.sendInputEvent()` 对非聚焦桌宠窗口不生效。

因此 Windows 构建包含一个最小 Node-API addon。每次穿透状态变化并应用到 `BrowserWindow` 后，main 在下一个事件循环执行：

```text
GetCursorPos
  -> WindowFromPoint（重新选择角色窗口或下层应用）
  -> SendMessageTimeoutW(WM_NCHITTEST)
  -> SendMessageTimeoutW(WM_SETCURSOR)
```

消息设置 50 ms `SMTO_ABORTIFHUNG` 超时，避免下层应用无响应时阻塞 Electron main。该方案不移动系统鼠标、不抢焦点，也不直接替下层应用选择 cursor。`0.01` 等亚像素位移不可作为替代：Win32 cursor/message 坐标最终是整数像素，同一整数位置的 `SetCursorPos` 不保证生成新的命中消息。

`npm run desktop` 会先执行 `npm run build:native`。Windows 开发环境需要 Python 和 Visual Studio C++ Build Tools；构建输出位于被忽略的 `native/cursor-refresh/build`。非 Windows 平台跳过该原生模块。

当前前台只有 Live2D 角色，因此最终 alpha 等价于角色 Coverage。后续 Scene Renderer 接入多个 Actor 后，应将同一适配器绑定到 Scene Engine 定义的最终 Coverage/Picking pass；异步请求和迟到结果隔离逻辑无需改变。

模型适配尺寸始终使用 Live2D `internalModel.width/height`，不使用已经包含 DisplayObject scale 的 `model.width/height`。因此窗口移动、重复 resize 或跨 DPI 显示器切换不会把当前缩放再次代入并造成画面交替放大；右键“恢复默认位置”也会重新发布 bounds 并触发稳定的 refit。Electron 在 Windows 上使用默认 always-on-top level，避免 macOS 专用 level 导致置顶状态丢失。

## 实现方案差异

| 方案 | 桌面交互 | 角色点击 | 主要代价 |
| --- | --- | --- | --- |
| 大面积透明窗口始终可交互 | 透明区域也会挡住桌面 | 最简单 | 不满足桌面角色“不打扰”目标 |
| 整窗永久穿透 | 完全不挡桌面 | 不可点击、不可拖动 | 只能依赖托盘、快捷键等外部入口 |
| 按 HitArea 动态切换整窗穿透 | HitArea 外可见像素也会穿透 | 只能点击作者标记区域 | 不能满足所有可见像素可点击 |
| 最终帧邻域 Coverage（当前） | 透明区点击落到桌面 | 所有实际可见像素可点击、可拖动 | 选取状态比画面晚约一个 GPU fence |
| 原生 `setShape` 裁切窗口 | 形状外天然不接收点击 | 形状内可点击 | 平台差异明显，动画网格需频繁重建矩形区域，难以做像素级轮廓 |
| 全屏透明 overlay | 方便做全桌面特效 | 需同样实现动态穿透 | 更容易误拦截桌面，当前无必要 |

当前方案同时满足透明区域穿透和“所有可见像素可点击”。不应退回整块矩形可点击，因为那会重新吞掉角色轮廓内的大量透明点击。

## 进程与安全边界

- main 独占窗口创建、bounds、置顶、鼠标穿透和原生菜单。
- preload 在 `contextIsolation + sandbox` 下只暴露固定 IPC，不暴露 Node 或原始 `ipcRenderer`。
- renderer 只发送屏幕点、穿透布尔值和菜单意图；main 校验 IPC sender 和参数。
- 正式构建通过安全的 `desktop-char://app/` 自定义协议读取本地产物。
- 开发 URL 只允许 `http://127.0.0.1`、`localhost` 或 IPv6 loopback，禁止把有 Node 桥的窗口导航到远程页面。
- 页面 CSP 禁止 `unsafe-eval`；Pixi 使用兼容 CSP 的 shader compiler。

## 启动与验收

```bash
npm run desktop
npm run test:desktop
npm run test:desktop-smoke
```

`npm run desktop` 会先构建再启动透明悬浮窗口。`body` 的 `data-pixel-readback` 会显示 `async-pbo` 或 `sync-readpixels`；`data-pixel-sample` 是最新原始样本，`data-pixel-selection` 是防抖后的确认状态，并额外记录 alpha、命中/透明连续计数、提交/完成帧号与 fence 延迟帧数。自动烟雾测试会验证窗口透明/置顶/尺寸、像素读取适配器已启用、初始穿透、拖动后原生 bounds，以及 renderer 收到的 bounds 是否一致。
