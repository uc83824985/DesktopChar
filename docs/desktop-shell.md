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

窗口固定透明、置顶、无任务栏图标，默认位于主屏工作区右下角。拖动使用屏幕坐标计算新的位置，并将完整窗口限制在距离最近显示器的工作区内。Windows 默认通过 Koffi 调用位置专用的 `SetWindowPos`，其他平台或原生适配不可用时回退 `BrowserWindow.setBounds()`；坐标不变时不重复提交。main 持有 DIP 逻辑 bounds，避免原生像素与高 DPI 换算造成宽高在 460/461 间抖动，renderer 仅在逻辑宽高实际变化时重新 fit 模型。

## 后台托盘与显隐生命周期

Electron main 在系统通知区域创建常驻 `DesktopChar` 托盘入口。左键单击托盘图标切换角色窗口显示/隐藏；右键菜单根据当前状态显示“显示角色”或“隐藏角色”，同时提供“恢复默认位置”和“退出 DesktopChar”。角色自身的共享右键菜单也注册“隐藏角色”，隐藏后通过托盘恢复。

隐藏不会关闭窗口、卸载 Renderer、重建 Avatar Runtime、断开角色接入/语音合成 MCP，或重置窗口 bounds；恢复沿用不抢占当前前台应用焦点的 `showInactive()`，但在呈现握手完成前保持透明，不重提未变化的窗口几何。`DesktopWindowState.visible` 和 `tray.available` 提供可测试事实。托盘使用随 Electron shell 打包的 `assets/TrayIcon.png` 角色头像；它不依赖 Renderer 已加载或 Live2D 资源生命周期。后续可直接覆盖同名 PNG 并重启 DesktopChar，无需修改代码。

透明窗口从托盘恢复时不能把 `showInactive()` 当作完成点。隐藏会使 Chromium 默认进入后台节流，若 HWND 先显示、Pixi/Live2D 后恢复交换帧，Windows 合成器可能短暂暴露空帧；恢复路径若同时重复提交置顶或 bounds，还会使这个切换看起来像一次缩放抖动。当前窗口关闭后台节流以保持 Runtime 与渲染时间线连续；隐藏时先把窗口 opacity 设为 0 再 `hide()`，恢复时保持 opacity 0 调用 `showInactive()`，通过 `webContents.beginFrameSubscription()` 等待真实 presentation event 后才恢复 opacity 1。恢复不再重复提交未变化的 bounds 或置顶状态。1 秒保护超时只用于 Renderer 异常时避免窗口永久不可见，并输出错误日志。

`DesktopWindowState.presentation` 公开 `hidden | warming | visible`、恢复请求编号、opacity 和后台节流事实。Electron smoke 会执行真实“隐藏→恢复”命令，并断言 presentation 完成前不显现、恢复前后模型 scale、窗口 bounds 和 WebGL context-loss 计数保持一致。参考 Electron 官方 [BrowserWindow 页面可见性与优雅显示](https://www.electronjs.org/docs/latest/api/browser-window#showing-the-window-gracefully) 和 [webContents frame subscription](https://www.electronjs.org/docs/latest/api/web-contents#contentsbeginframesubscriptiononlydirty-callback)。

Windows 托盘的基础尺寸是 16 DIP，不等于固定 16 个物理像素：在 125%、150%、175%、200% 缩放下分别需要 20、24、28、32 像素。main 从源 PNG 直接生成 16/20/24/28/32/40/48 像素表示，并通过 `nativeImage.addRepresentation()` 标注对应 scale factor，让系统选取当前显示器的原生表示；禁止先固定缩成 16×16 再由 Windows 放大。该策略消除了二次采样模糊，但图案在 24×24 内能保留多少内容仍由原始构图决定：若头像包含过多细线和低对比度细节，应另行制作高对比度、透明背景的小尺寸专用素材，而不是继续增加缩放算法。

通知区图标是否直接展开在任务栏右下角或收进系统溢出面板由 Windows 用户设置决定，应用不强行修改系统托盘布局。

## 点击与拖动

- 指针位置的最终帧像素透明：整个窗口临时进入鼠标穿透，点击落到原桌面应用。
- 指针位置存在可见像素：恢复窗口交互，可左键点击或拖动。
- 默认按住 180 ms 后才进入拖动准备状态并显示 `move` 光标；此前松开且位移小于 5 DIP，解释为角色点击并向 Runtime 发送 `user.avatar-clicked`。
- 快速按下期间即使产生超过 5 DIP 的明显移动，也只取消本次点击，不启动窗口拖动或闪烁 `move` 光标。
- 最初按下的屏幕位置始终是拖动锚点。达到按住阈值并完成渲染/原生拖动准备后，阈值期间累计的鼠标位移会一次应用到窗口，使最初按住的角色像素重新跟随鼠标；不得在延迟结束时把当前鼠标改为新锚点，否则会产生可见的按住位置漂移。
- 角色上右键：显示由对象注册贡献合并得到的共享 DOM 设置菜单。

按住阈值在 `desktop-char.config.json` 的 `interaction.drag.holdDelayMs` 配置，接受 `0..999` 的整数毫秒，默认 `180`。配置热重载后随桌面 `windowState.interaction` 下发，renderer 不读取进程环境变量；`DESKTOP_CHAR_DRAG_HOLD_DELAY_MS` 只保留为迁移期 fallback。

### 拖动黑闪排查与修复

第一次排查将 `setBounds()` 改为看似更精确的 `setPosition()`，同时停止 renderer 在纯位置 move 上重新 fit 模型。实机 A/B 随后证明：`setPosition()` 会让原先只在进入拖动时偶发的黑闪，变成持续拖动期间的稳定高频黑闪，因此该路径已撤销。随后尝试的“拖动前请求完整 repaint、等待一帧 Pixi `postrender`、不重复提交 `setIgnoreMouseEvents(false)`”消除了应用内时序竞争，但实机仍能观察到首次位置提交的透明窗口黑闪，说明剩余问题位于 Chromium/DWM 原生窗口移动路径。

当前 Windows backend 改为 Koffi `SetWindowPos`，只提交 X/Y，并固定使用 `SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOSENDCHANGING | SWP_DEFERERASE`。其中没有设置会丢弃客户区内容的 `SWP_NOCOPYBITS`；Windows 因而可以保留并复制已有客户区表面，同时 `SWP_NOSIZE` 保证移动不会误入 resize 路径，`SWP_DEFERERASE` 避免同步生成 `WM_SYNCPAINT`。参考 Microsoft [SetWindowPos](https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-setwindowpos)。

当前拖动路径改为：

```text
pointer move
  -> main 计算并约束目标位置
  -> DIP 坐标转换为原生屏幕坐标
  -> SetWindowPos(HWND, x, y, SWP_NOSIZE | ... | SWP_DEFERERASE)
  -> move fact 回传 renderer
  -> 回传 main 持有的逻辑 bounds；窗口宽高未变则不执行 fitModel
```

`DESKTOP_CHAR_DRAG_WINDOW_API=setBounds` 可强制回退旧路径，用于设备级 A/B；`auto`（默认）和 `native` 在 Windows 原生 adapter 可用时选择 `native-set-window-pos`。若原生调用失败，会记录 Win32 error 并对本次提交回退 `setBounds`。

Windows 开发机可运行 `npm run diagnose:drag -- native`：诊断程序用真实系统鼠标走完整的按住拖动流程，并通过 Win32 `BitBlt(CAPTUREBLT)` 以内存方式采样实际 HWND 屏幕区域，不保存截图；一旦移动区间出现近全黑或色彩/亮度方差同时大幅下降，会返回非零退出码并列出可疑帧。当前机器连续 5 轮、约 160 个首次移动区间采样帧均为 `suspectedBlankFrames: 0`。正式运行只保留原生移动失败、renderer 崩溃或 WebGL context 丢失等异常日志，不输出逐帧拖动和像素选取诊断。

进入拖动时只需要把光标语义从 `pointer` 改为 `move`，窗口在按住前已经处于 `passthrough=false`。旧实现仍会重复调用 `setIgnoreMouseEvents(false)`；Electron 将该 API 定义为修改整窗鼠标忽略状态，`forward` 也只在 `ignore=true` 时有效，因此同值重提没有业务意义，却可能让 Windows 重新提交透明窗口的命中/扩展样式。当前 PointerPresentation adapter 分离两个变化：

- `passthrough` 实际改变时才调用 `setIgnoreMouseEvents()`；
- 仅 `pointer -> move` 时只更新 CSS/Win32 cursor，不修改窗口穿透样式、不执行 `SWP_FRAMECHANGED`、不注入鼠标往返；
- 首次创建窗口仍强制应用一次初始穿透状态，不能被同值过滤误删。

延迟拖动激活时，main 先记录 `move` 语义但不立即刷新 Windows cursor，避免光标消息与透明窗口首次位置提交竞争。Renderer 等待一个完整 `postrender` 后，通过同一 PointerPresentation 入口重提当前 `move` 语义；main 只强制刷新原生光标，不重提窗口穿透，并在第一次累计位移前完成。

该 PointerPresentation 优化和原生窗口移动 backend 相互独立：前者避免拖动入口修改命中样式，后者避免首次坐标提交进入 Chromium 完整 bounds/重绘路径。参考 Electron [BrowserWindow.setIgnoreMouseEvents](https://www.electronjs.org/docs/latest/api/browser-window#winsetignoremouseeventsignore-options) 和 [自定义窗口交互](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)。

## 透明窗口合成故障对照记录

拖拽黑闪和托盘恢复闪黑/抖动都发生在透明 Electron 窗口与 Windows DWM 的交界处，但不是同一种时序，不能复用同一个“多等一帧”修复。两次问题的稳定实现分别落在 `5df07ee`（拖拽）和 `5e937cf`（恢复）；前者还包含此前 `f02898c` 对重复缩放的修正。

| 对照项 | 拖拽首次移动/持续移动黑闪 | 后台恢复闪黑及类似缩放的抖动 |
| --- | --- | --- |
| 触发的宿主变化 | 高频修改透明 HWND 的屏幕位置 | `hide()` 后重新 `showInactive()`，改变 HWND 可见性 |
| Renderer 事实 | Pixi 动画正常，模型无需 resize；纯位置变化不应重新 fit | Runtime 和模型仍存在，但隐藏窗口默认可能被 Chromium 后台节流 |
| 最有辨识度的现象 | `setPosition()` 反而把偶发首帧黑闪放大为持续高频黑闪 | 窗口先恢复可见，随后才出现有效角色帧；重复置顶/bounds 使切换看起来像缩放 |
| 已排除路径 | repaint、等待 Pixi `postrender`、重复取消鼠标穿透；它们只能消除应用内竞争 | 仅调用 `showInactive()`、重新设置置顶、重新发布未变化 bounds；窗口“已显示”不等于新帧“已呈现” |
| 最终边界结论 | Electron 完整 bounds 路径可能触发 DWM 客户区重绘/擦除；位置移动必须保留已有表面且不能混入 resize | HWND 显示早于可呈现帧；后台节流和无呈现门控会暴露空帧或旧表面 |
| 有效修复 | Koffi `SetWindowPos` 只提交 X/Y，使用 `SWP_NOSIZE`、`SWP_NOZORDER`、`SWP_NOACTIVATE`、`SWP_DEFERERASE` 等标志；main 保持唯一逻辑 bounds | `backgroundThrottling=false`；隐藏前 opacity 0；恢复后保持 opacity 0，等待 `beginFrameSubscription()` presentation event 再显现；请求编号隔离迟到回调 |
| 回归依据 | 原生 `BitBlt(CAPTUREBLT)` 对真实 HWND 连续采样，检查可疑黑帧；同时断言宽高与模型 scale 不变 | 连续四轮真实隐藏/恢复，断言 presentation 完成、opacity、bounds、模型 scale 和 WebGL context-loss 均稳定 |

这里最重要的分层是：

```text
Runtime 状态正确
  -> Renderer 已执行 update/postrender
  -> Chromium 已提交可用 surface
  -> Windows DWM 已呈现透明 HWND
```

上层完成不能证明下层完成。Pixi `postrender` 只说明 Renderer 完成了一次渲染回调，不能证明 DWM 已收到或呈现该帧；`BrowserWindow.isVisible()` 只说明 HWND 可见，也不能作为首帧栅栏。因此后续遇到闪黑、短暂透明、残留帧或“像缩放”的跳变，应依次记录以下事实，而不是先增加任意延迟：

1. Runtime 是否重建、模型 scale 是否变化、WebGL context 是否丢失；
2. 逻辑 bounds 的 X/Y 与宽高是否变化，是否出现 DIP/物理像素往返；
3. Renderer 是否完成帧，窗口操作是否重复提交同值的 bounds、置顶、穿透或 cursor 样式；
4. HWND 操作是否混入 resize、Z-order、activation、erase 或 frame-change 语义；
5. 问题需要的是 Renderer frame fence、Chromium presentation fence，还是 DWM 屏幕采样验收。

通用实现约束如下：位置、尺寸、可见性、穿透和光标是不同状态通道；只提交真实发生变化的通道。高频位置更新必须使用 position-only backend，显隐切换必须使用 presentation-gated reveal。为了掩盖问题而同时重提 bounds、置顶或样式，会增加合成变量并使根因更难定位。固定毫秒延迟只能作为带错误日志的保护超时，不能作为正常呈现条件。

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
- `covered` 状态通过统一 `PointerPresentation` 使用 `pointer`，拖动期间使用 `move`；canvas 内联 cursor 和 Win32 cursor 都只消费这一份语义，Pixi 不再拥有独立光标判断。

### Windows 光标刷新

Windows 通常只在真实鼠标移动时向当前目标窗口发送 `WM_SETCURSOR`。动画可以在鼠标静止时改变 Coverage 和窗口穿透状态，此时点击已经命中新目标，但系统光标外观可能仍属于切换前的窗口。Electron 没有公开主动刷新光标或发送 Win32 消息的 API，且 `webContents.sendInputEvent()` 对非聚焦桌宠窗口不生效。

因此 Windows 宿主通过 Koffi 加载系统 `user32.dll`。每次穿透状态变化并应用到 `BrowserWindow` 后，main 合并为最新一次请求，并在约一个渲染帧后执行：

```text
GetCursorPos
  -> WindowFromPoint（诊断当前系统坐标目标）
  -> getNativeWindowHandle（进入交互时明确选择角色 HWND）
  -> SetWindowPos(SWP_FRAMECHANGED | SWP_NOACTIVATE)
  -> SendMessageTimeoutW(WM_NCHITTEST)
  -> SendMessageTimeoutW(WM_SETCURSOR)
  -> SetCursor
```

消息设置 50 ms `SMTO_ABORTIFHUNG` 超时，避免目标窗口无响应时阻塞 Electron main。单靠上述调用仍不足以刷新未聚焦窗口的静止进入：Windows 当前输入队列可能继续保留下层窗口的光标。此时仅在 `unfocused && passthrough -> interactive` 边沿追加一次 `1px -> 原坐标` 的不可合并系统鼠标事件，让系统重新完成命中路由；不激活窗口，也不持续注入。

#### 排障结论与经验

- Coverage 日志已经进入 `pointer` 但外观未变化，不代表 GPU readback 或选择队列失败；应先比较 `data-cursor-intent`、`data-computed-cursor` 和 main 的 PointerPresentation。
- `refreshed: true` 不能只表示 `SendMessageTimeoutW` 成功送达。诊断需区分 `delivered`、`handled`、`cursorSet`、`frameRefreshed` 和最终的系统输入重路由。
- `WindowFromPoint` 在刚取消穿透时可能仍返回下层窗口，因此进入交互必须明确使用 `BrowserWindow.getNativeWindowHandle()`，同时保留 `pointTargetIsRequested` 作为诊断事实。
- `focused=true` 时刷新成功、`focused=false` 时失败，说明差异位于 Windows 前台输入队列，而不是 Coverage fence、IPC 顺序或 HWND 选择。
- `focus()`、临时激活和 `AttachThreadInput` 均不作为正式方案：前两者会抢占或扰动用户焦点，后者会耦合输入队列并可能重置键盘状态。
- `SetCursorPos(x, y)` 的同坐标调用以及单个同坐标 `SendInput` 均可能被系统静默或无法触发新命中；亚像素位移在 Win32 整数坐标中也无意义。
- 最终方案使用同一批 `SendInput` 提交相邻整数像素和原坐标，并设置 `MOUSEEVENTF_MOVE_NOCOALESCE`。系统逻辑会处理两次移动并刷新 `WM_SETCURSOR`，但通常在下一次屏幕合成前已回到原位，因此肉眼看不到位移。
- 该兼容动作必须保持边沿触发：只在未聚焦的穿透→交互转换执行一次。禁止在每帧、持续 Coverage 或角色内部移动时重复执行，避免额外 hover 和输入副作用。
- 验收时应看到 `cursorNudgeAccepted: true`，并确认前台应用未失焦、最终鼠标坐标不变、静止进入和退出均能更新外观。

Koffi 使用随 npm 包提供的 Windows x64 预编译 N-API 二进制，因此 `npm install` 后即可运行，不再需要 Python、`node-gyp` 或 Visual Studio C++ Build Tools。业务侧仍只依赖 `NativeCursorBridge.refresh()`，不直接散布 FFI 声明；非 Windows 平台返回明确的 unavailable adapter。

### Koffi 原生扩展边界

Koffi 只用于 Electron 没有公开等价能力、且调用短小同步的 Win32 宿主适配，不成为通用业务依赖。后续可能复用的能力包括：

- `WindowFromPoint`、`GetAncestor`、`GetWindowThreadProcessId`：识别角色下方的桌面窗口，用于上下文提示或安全的交互目标诊断；
- `DwmGetWindowAttribute`：读取扩展窗口边界、cloaked 状态等 Electron 未完整暴露的 DWM 事实；
- `DwmSetWindowAttribute`：在 Electron 缺少对应开关时设置 Windows 专属的非客户区表现，但必须集中在 shell adapter；
- `SendMessageTimeoutW`：向已确认的目标窗口发送无副作用、带超时的系统刷新/查询消息；
- `GetCursorInfo`、`GetDoubleClickTime`、`SystemParametersInfoW`：读取系统输入和可访问性偏好，使拖动阈值、动画或提示符合用户设置；
- 必要时实现 `SetWindowRgn` 或扩展 window style 的实验 adapter，用于静态/低频原生命中区域；动画逐像素轮廓仍优先使用当前 Coverage 方案。

以下能力即使 Koffi 可以调用，也不应默认采用：

- 窗口 bounds、显示器、置顶、焦点、全局快捷键继续使用 Electron `BrowserWindow`、`screen`、`globalShortcut`，避免双重状态所有者；
- `SetCursorPos` 不用于伪造用户输入或移动真实鼠标；`SendInput` 仅允许由 PointerPresentation adapter 在未聚焦的穿透→交互边沿执行一次已测试的 1px 往返，不开放为通用输入注入能力；
- 低级键鼠 hook、长期回调和高频 Raw Input 不在 Electron main 内直接运行，确有需求时应放到隔离 worker/sidecar；
- 不向任意 HWND 转发业务命令，不绕过权限、完整性级别或目标进程协议；
- renderer、Scene Runtime 和 Avatar Runtime 不导入 Koffi，所有 Win32 结果必须先收敛为宿主层事实或 capability。

每个新增 Win32 调用都必须固定 DLL、函数签名、参数范围和超时策略，并提供非 Windows/加载失败的降级路径。涉及指针、回调或结构体生命周期时，应优先建立单独 adapter 和真实平台测试，而不是在 main 中内联 FFI。

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

- main 独占窗口创建、bounds、置顶、鼠标穿透、托盘生命周期和显示/隐藏/恢复位置/退出等白名单桌面能力。
- preload 在 `contextIsolation + sandbox` 下只暴露固定 IPC，不暴露 Node 或原始 `ipcRenderer`。
- renderer 只发送屏幕点、统一 PointerPresentation 和白名单窗口命令；共享 DOM 菜单只负责收集对象注册并发出这些意图，main 校验 IPC sender 和参数。
- 正式构建通过安全的 `desktop-char://app/` 自定义协议读取本地产物。
- 开发 URL 只允许 `http://127.0.0.1`、`localhost` 或 IPv6 loopback，禁止把有 Node 桥的窗口导航到远程页面。
- 页面 CSP 禁止 `unsafe-eval`；Pixi 使用兼容 CSP 的 shader compiler。

## 启动与验收

```bash
npm run desktop
npm run test:desktop
npm run test:desktop-smoke
npm run diagnose:topmost
```

`npm run desktop` 会先构建再启动透明悬浮窗口。`body` 的 `data-pixel-readback` 会显示 `async-pbo` 或 `sync-readpixels`；`data-pixel-sample` 是最新原始样本，`data-pixel-selection` 是防抖后的确认状态，并额外记录 alpha、命中/透明连续计数、提交/完成帧号与 fence 延迟帧数。自动烟雾测试会验证窗口透明/置顶/尺寸、像素读取适配器已启用、初始穿透、拖动后原生 bounds，以及 renderer 收到的 bounds 是否一致。

`diagnose:topmost` 使用隔离的 user-data 和动态 loopback 端口启动真实 Electron 窗口，
从进程外清除原生 `WS_EX_TOPMOST`，再确认 watchdog 在不改变 presentation request、
opacity 或焦点的情况下恢复置顶。它用于区分“窗口/渲染丢失”和“Electron 仍报告
always-on-top，但原生 Z-order 已被截图工具修改”。

### PointerPresentation 单入口

桌面交互以 `{ passthrough, cursor }` 作为不可拆分的 `PointerPresentation` 提交。Coverage、拖动和退出只调用 renderer 内同一个控制入口；preload 不再暴露独立的 `setMousePassthrough`。Electron main 校验组合后，同时应用窗口穿透和 Windows 光标刷新。CSS backend 与 Koffi backend 只消费相同的 `default | pointer | move` 语义，不各自判断像素选择状态。

Windows 静止鼠标切换使用 `SetCursor` 应用同一语义对应的系统资源；刷新延后一个渲染帧，并且队列中只保留最新的 `PointerPresentation`，避免 Chromium 在窗口穿透切换提交后再次用旧 CSS cursor 覆盖结果。不再使用零位移 `SetCursorPos`，因为它是否产生新鼠标消息依赖焦点和历史输入状态，不能作为刷新协议。当前 `pointer` 在 CSS 与 Win32 都对应系统链接手形，`move` 对应系统移动光标，从而避免真实移动与静止动画覆盖显示两种不同资源。

从穿透进入可交互时，main 通过 `BrowserWindow.getNativeWindowHandle()` 把角色 HWND 明确传给 Koffi，不依赖切换瞬间可能仍指向下层窗口的 `WindowFromPoint`。该转换以 `SetWindowPos(SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER)` 提交命中样式，然后直接向角色 HWND 查询命中并刷新光标，不抢占前台焦点。日志同时记录 `focused`、`targetIsRequested`、`pointTargetIsRequested` 和 `foregroundIsRequested`，用于区分显式刷新、坐标命中和窗口激活状态。

若该转换发生在角色窗口未聚焦时，Windows 不一定采用后台输入线程调用的 `SetCursor`。宿主会额外发送一次相邻整数像素再立即返回原坐标的 `SendInput` 往返，使用虚拟桌面绝对坐标、`MOUSEEVENTF_VIRTUALDESK` 和 `MOUSEEVENTF_MOVE_NOCOALESCE`，要求系统重新执行真实命中路由，但不调用 `focus()`、不改变前台窗口。该动作仅发生在 `passthrough -> interactive` 边沿，不在持续动画或每帧执行；日志以 `cursorNudgeAccepted` 标记系统是否接收完整的两步输入。
