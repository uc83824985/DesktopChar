# Live2D Desktop Character

事件驱动的 AI 桌面角色运行时。Avatar Runtime 是状态唯一所有者；UI、播放器和渲染器只发送事实事件或执行 Runtime Effects。

## 模块

- `apps/desktop`：Electron main/preload/renderer 与可复用的浏览器前台测试壳。
- `packages/contracts`：跨模块事件、效果和领域类型。
- `packages/avatar-runtime`：状态机、Planner、Timeline 与 Parameter Mixer。
- `packages/scene-runtime`：通用 Scene Actor、关系约束、原子事务、Behavior 路由与 2.5D 渲染计划。
- `packages/live2d-renderer`：模型无关端口、生命周期和 Live2D 适配边界。
- `packages/audio-runtime`：真实播放时钟与原始 PCM 电平事实接口；角色级口型增益由 Runtime 应用。
- `packages/tts-mcp-adapter`：语音合成 MCP（技术标识 TTS）输出适配。
- `packages/transport`、`packages/config`：传输和配置边界。
- `local-tts-mcp`：可独立运行的真实 Streamable HTTP MCP/HTTP PCM 参考服务；默认固定音高 `jrpg-blip` 按字生成提示音、标点停顿及 sample-aligned 文本 cue，并保留确定性变化音调 `jrpg-blip-varied`。
- `performance-model-service`：Qwen3.5-2B 首个本地表现模型开发环境；通过独立
  Transformers OpenAI-compatible 服务暴露能力，不向引擎包泄漏模型实现。

详细设计见 [架构文档](docs/architecture.md)、[Avatar Runtime](docs/avatar-runtime.md)、[Scene Engine 抽象](docs/scene-engine.md) 和 [配置所有权与 JSON 重构方案](docs/configuration.md)。

角色级视线校准及资源修改边界见 [GazeProfile 工作流](docs/gaze-calibration.md)；透明区穿透、角色点击/拖动和窗口包围盒同步见 [透明桌面悬浮壳](docs/desktop-shell.md)。
动态场景 UI 使用与 Scene Frame 同 revision 的框架无关 Surface，参考项目取舍和引擎/应用边界见 [桌面 UI 引擎层设计](docs/desktop-ui-engine.md)。
角色语音可通过应用层聊天气泡以完整、渐进追加或 KTV 高亮方式投影，契约和 Agent 示例见 [角色聊天气泡](docs/speech-bubble.md)。
语音合成 MCP Client 与角色接入 MCP Server 均支持右键动态启停、JSON 配置热重载、指数退避重连和官方 Client 连接测试，配置及角色工具见 [MCP 服务生命周期与角色接入接口](docs/mcp-services.md)。

可独立运行的样例见 [本地语音合成 MCP 参考服务](local-tts-mcp/README.md)；Adapter、流式 MCP/HTTP 绑定和真实服务接入契约见 [TTS Adapter 文档](docs/tts-adapter.md)；MCP 侧新增语速、sample 时间线和可选生成事件时参照 [Qwen3-TTS MCP 流式扩展说明](docs/tts-mcp-streaming-extension.md)；Qwen3-TTS 当前公开推理接口的流式能力核对见 [Qwen3-TTS 阅读记录](docs/references/qwen3-tts.md)。

外部 Agent 可通过角色接入 MCP 或兼容的 loopback HTTP 控制面提交完整表演计划、发起中断并读取 Runtime 状态；HTTP 协议与 PowerShell 示例见 [外部 Agent 本地 HTTP 接入指南](docs/external-agent-http.md)。

高频输入、主动聊天和多 Agent 的目标架构由应用统一持有 ConversationLedger、版本化 Persona、Turn/Task 调度和唯一 PerformanceQueue；设计缺陷约束及下一阶段决策项见 [对话上下文与任务编排设计](docs/conversation-orchestration.md)。

表情和已有 Live2D 动作的语义选择暂由本地表现推理端口完成，Qwen3.5-2B non-thinking 只是首个验证 Profile，不进入外部 Agent 关键路径；同协议模型只需替换 Profile，不同协议通过新 Adapter 接入。首个模型使用 OpenAI-compatible HTTP，不新增 MCP；`external` 只连接现有 endpoint，`managed` 由 Electron Supervisor 启停入口进程，两者复用同一 Adapter。边界与生命周期见 [本地表现模型接入设计](docs/performance-model-integration.md)，实现新 Provider 时遵循 [表现模型 Provider 接入指南](docs/performance-model-provider-integration.md)，官方模型配置阅读结论见 [Qwen3.5-2B 阅读记录](docs/references/qwen3.5-2b.md)。

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

## 验证

```bash
npm run check
npm run diagnose:tts
npm run diagnose:topmost
npm audit --omit=dev
npm run test:smoke
npm run test:desktop-smoke
```

`test:smoke` 在 Windows Edge 中实际加载 Core、Mao 模型和纹理，并操作三个前台按钮；`test:desktop-smoke` 另外启动真实 Electron 窗口验证透明、置顶、穿透、拖动和 bounds 同步。首次启动前请阅读 [Live2D 资源与许可说明](docs/live2d-assets.md)。
