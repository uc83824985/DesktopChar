# Live2D Desktop Character

事件驱动的 AI 桌面角色运行时。Avatar Runtime 是状态唯一所有者；UI、播放器和渲染器只发送事实事件或执行 Runtime Effects。

## 模块

- `apps/desktop`：Electron main/preload/renderer 与可复用的浏览器前台测试壳。
- `packages/contracts`：跨模块事件、效果和领域类型。
- `packages/avatar-runtime`：状态机、Planner、Timeline 与 Parameter Mixer。
- `packages/scene-runtime`：通用 Scene Actor、关系约束、原子事务、Behavior 路由与 2.5D 渲染计划。
- `packages/live2d-renderer`：模型无关端口、生命周期和 Live2D 适配边界。
- `packages/audio-runtime`：真实播放时钟与原始 PCM 电平事实接口；角色级口型增益由 Runtime 应用。
- `packages/conversation-runtime`：单角色 Char worker、多 Turn 回复、提前准备与有序呈现。
- `packages/interaction-routing`：不可变交互消息、sticky 目标、Router 结果校验与无副作用裁决。
- `packages/tts-mcp-adapter`：语音合成 MCP（技术标识 TTS）输出适配。
- `packages/transport`、`packages/config`：传输和配置边界。
- `tts-mcp-profiles`：可提交的跨设备 TTS Provider Profile；设备专属启动配置使用被忽略的 `*.local.json`。
- `local-tts-mcp`：可独立运行的真实 Streamable HTTP MCP/HTTP PCM 参考服务；默认固定音高 `jrpg-blip` 按字生成提示音、标点停顿及 sample-aligned 文本 cue，并保留确定性变化音调 `jrpg-blip-varied`。
- `performance-model-service`：Qwen3.5-2B 首个本地表现模型开发环境；通过独立
  Transformers OpenAI-compatible 服务暴露能力，不向引擎包泄漏模型实现。
- `temp`：开发截图、审阅导出和一次性诊断文件的统一临时目录；除目录说明外默认不进入 Git。

详细设计见 [架构文档](docs/architecture.md)、[Avatar Runtime](docs/avatar-runtime.md)、[Scene Engine 抽象](docs/scene-engine.md) 和 [配置所有权与 JSON 重构方案](docs/configuration.md)。项目初始技术选型归档于 [AI 桌面角色选型调研](docs/references/desktop-character-selection.md)。

角色级视线校准及资源修改边界见 [GazeProfile 工作流](docs/gaze-calibration.md)；透明区穿透、角色点击/拖动和窗口包围盒同步见 [透明桌面悬浮壳](docs/desktop-shell.md)。
动态场景 UI 使用与 Scene Frame 同 revision 的框架无关 Surface，参考项目取舍和引擎/应用边界见 [桌面 UI 引擎层设计](docs/desktop-ui-engine.md)。
Live2D Motion 可通过受全局帧预算约束的真实 WebGL 采集器导出 Contact Sheet、采样时点和参数轨迹，使用方式见 [自动动作审阅工具](docs/motion-audit.md)。
角色语音可通过应用层聊天气泡以完整、渐进追加或 KTV 高亮方式投影，契约和 Agent 示例见 [角色聊天气泡](docs/speech-bubble.md)。
语音合成 MCP Client 与角色接入 MCP Server 均支持右键动态启停、JSON 配置热重载、指数退避重连和官方 Client 连接测试，配置及角色工具见 [MCP 服务生命周期与角色接入接口](docs/mcp-services.md)。

可独立运行的样例见 [本地语音合成 MCP 参考服务](local-tts-mcp/README.md)；Adapter、流式 MCP/HTTP 绑定和真实服务接入契约见 [TTS Adapter 文档](docs/tts-adapter.md)；MCP 侧新增语速、sample 时间线和可选生成事件时参照 [Qwen3-TTS MCP 流式扩展说明](docs/tts-mcp-streaming-extension.md)；Qwen3-TTS 当前公开推理接口的流式能力核对见 [Qwen3-TTS 阅读记录](docs/references/qwen3-tts.md)。

外部 Agent 可通过角色接入 MCP 或兼容的 loopback HTTP 控制面提交完整表演计划、发起中断并读取 Runtime 状态；HTTP 协议与 PowerShell 示例见 [外部 Agent 本地 HTTP 接入指南](docs/external-agent-http.md)。

高频输入、主动聊天和多 Agent 的目标架构由应用统一持有 ConversationLedger、版本化 Persona、Turn/Task 调度和唯一 PerformanceQueue。多 Agent 只跨 Turn 并行生成文本；sealed 文本尽早扇出到 TTS 与本地表情/动作准备队列，正式提交和播放仍保持单写顺序。生产 Reply 数据面采用 DesktopChar 托管的单个 Codex App Server，不连接或污染用户正在使用的 CLI 会话。总体约束见 [对话上下文与任务编排设计](docs/conversation-orchestration.md)，当前框架与测试方式见 [多 Agent 回复流水线开发说明](docs/multi-agent-development.md)。

跨项目任务通知与回复路由是另一条链路：独立常驻 Task Manager 只监控会话并执行已经解析为
`sessionId + text` 的命令；DesktopChar 内部的 Router Agent 负责候选会话判断，Char Agent
负责角色化表达，两者允许绑定独立 Provider/Profile。边界、用户可见时间线和二次确认规则见
[Task Manager 与会话路由设计](docs/task-manager-routing.md)。

Task Manager 首个内存版本位于 `task-manager/`。设置 `SESSION_MONITOR_MARKER` 后可运行
`node task-manager/server.mjs`；服务只监听 loopback，并在本机状态目录写入临时 marker/token。
`npm run test:task-manager-monitor` 与 `npm run test:task-manager-service` 分别执行真实 Monitor
只读发现和完整常驻服务只读验收，不会向任何 CLI 提交输入。DesktopChar 已可通过
`taskManager.markerPath` 接收有界事件、在 main 保存后 ack，并由前台 Avatar Runtime 播放固定
终态通知；`npm run test:task-manager-foreground` 使用隔离服务验证这条链路，不提交任务命令。
现有角色对话框已增加 sticky 的 Auto/Char/Session 目标选择、候选状态与二次确认区域；
`npm run test:routing-foreground` 会用隔离 Session 验证两次直接提交、Router 严格失败边界，
再切换 Char 通过 managed Codex 完成一轮真实前台回复。

表情和已有 Live2D 动作的语义选择暂由本地表现推理端口完成，Qwen3.5-2B non-thinking 只是首个验证 Profile，不进入外部 Agent 关键路径；同协议模型只需替换 Profile，不同协议通过新 Adapter 接入。首个模型使用 OpenAI-compatible HTTP，不新增 MCP；`external` 只连接现有 endpoint，`managed` 由 Electron Supervisor 启停入口进程，两者复用同一 Adapter。边界与生命周期见 [本地表现模型接入设计](docs/performance-model-integration.md)，实现新 Provider 时遵循 [表现模型 Provider 接入指南](docs/performance-model-provider-integration.md)，官方模型配置阅读结论见 [Qwen3.5-2B 阅读记录](docs/references/qwen3.5-2b.md)。

段内表情当前采用自然分句并发分析和文本位置锚点，不依赖 TTS 字词时间戳；Qwen3-ForcedAligner
的公开效率、流式限制、当前近似绑定策略及未来精确时间戳接入点见
[段内表情时序调研与阶段性实现](docs/expression-timing.md)。

Qwen3.5-2B 环境可通过 `npm run performance:bootstrap` 初始化，通过
`npm run performance:start` 启动；服务启动后在另一个终端执行
`npm run performance:smoke` 可完成真实 UTF-8 Chat Completions 验证。完整说明见
[本地表现模型服务](performance-model-service/README.md)。
`npm run diagnose:performance` 会进一步使用桌面端同一 Adapter 和严格白名单校验完成
领域契约诊断。要让桌面端实际使用该服务，将 `desktop-char.config.json` 中
`performanceInference.enabled` 设为 `true`；配置热重载后，新的 plan 会自动并行请求
表情/动作建议。
桌面版也可通过右键菜单“表现设置 → 表情动作推理”即时启停。菜单切换是本次运行的
临时覆盖，不改写 JSON；重新加载配置或文件热重载后重新采用
`performanceInference.enabled`。菜单会显示当前的“外部”或“托管”生命周期：
external 勾选只启用 Adapter，managed 勾选会启动配置的 Provider 入口进程并等待
健康检查通过；取消勾选或退出应用会回收 owned 进程树。
通过 `npm run desktop` 启动时，终端会输出 `[performance]` 前缀的结构化日志。
`request.completed` 中的 `source: "model"` 表示实际采用了模型响应；
`source: "rules"` 表示模型不可用后使用了规则回退。只有回复段没有显式表情或动作时
才会发起对应的推理请求。

## 一键前台测试

安装 Node.js 24 后，在仓库根目录执行：

```bash
npm install
npm start
```

`npm start` 会同时启动根目录的本地语音合成 MCP（TTS）服务和网页前台；`npm run desktop` 则由 Electron 自动在随机 loopback 端口启动同一服务实现。

桌面端用户参数统一从 JSON 读取。开发期可执行 `Copy-Item desktop-char.config.example.json desktop-char.config.json` 后修改；模型入口、GazeProfile 和 LipSyncProfile 位于模型目录旁的 `DesktopChar.character.json`。字段、热重载范围和仍保留为环境变量的启动项见 [配置所有权与 JSON 重构方案](docs/configuration.md)。

浏览器会自动打开 `http://127.0.0.1:5173`。看到“Runtime 已就绪”后，可测试本地语音合成 MCP、动作事件和鼠标视线跟随。UI 只向 Runtime 提交事件，模型参数由 Runtime Effects 驱动。

“口型同步验收”会播放一段先验已知的三段式 PCM 提示音，实时显示播放端、Mao 嘴部参数和 Pixi 渲染帧的响应时差，并将这些时差纳入自动验收；规则见 [先验铃声流与口型时点验收](docs/audio-lip-sync-acceptance.md)。

## 一键桌面悬浮测试

```bash
npm run desktop
```

这会构建并启动透明置顶角色，同时在系统通知区域创建后台托盘。单击托盘图标可切换角色显示，托盘右键可显示/隐藏、恢复位置或退出；角色自身右键菜单也提供“隐藏角色”。隐藏不会销毁 Runtime 或中断 TTS。最终渲染帧的透明像素保持点击穿透，所有实际可见像素均可左键点击或拖动；WebGL2 通过鼠标附近 `3×3` 像素的异步 PBO/fence 流水线更新选择状态。角色拖动直接移动原生窗口，窗口包围盒与显示位置同步更新。

左键角色会打开交互面板。顶部默认选择“角色对话”，可连续输入多条消息来观察多个
逻辑 reply Agent 的并行生成、后台准备和顺序播放；桌面端只维护一个隐藏的 Codex
App Server 进程，不为每个助手启动 CLI 窗口。“资源调试”二级页保留原有
表情、动作与基准姿态锁定按钮。详见[多 Agent 回复流水线开发说明](docs/multi-agent-development.md)。

## 验证

```bash
npm run check
npm run diagnose:tts
npm run diagnose:topmost
npm audit --omit=dev
npm run test:smoke
npm run test:desktop-smoke
npm run test:conversation-ui
```

`test:smoke` 在 Windows Edge 中实际加载 Core、Mao 模型和纹理，并操作前台按钮；`test:desktop-smoke` 另外启动真实 Electron 窗口验证透明、置顶、穿透、拖动和 bounds 同步；`test:conversation-ui` 专门验证对话/资源分类、跨 Turn 提前准备和有序播放。首次启动前请阅读 [Live2D 资源与许可说明](docs/live2d-assets.md)。
