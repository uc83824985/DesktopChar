# 单角色多 Agent 回复流水线开发说明

## 当前范围

多 Agent 只负责为同一个桌面角色跨 Turn 并行生成回复文本，不表示多个角色或多种人格。
所有 worker 都必须接收同一 Persona revision 的完整角色上下文。当前代码使用
`CharAgentEndpoint/CharReplyTask/CharReplyResult`，不是让无角色 Agent 先回复后再润色：

- `CharReplyTask` 外层保留 task/attempt/generation/deadline，Persona、消息与 revision
  从首版开始封装在 `CharContextEnvelope`，后续新增上下文不再平铺；
- Char Agent 返回一个或多个 sealed 文本 segment；
- TTS 和 `LocalPerformancePlanner` 在 sealed 后立即并行准备；
- `ConversationRuntime` 统一提交正式 assistant 消息；
- Avatar/Presentation Runtime 仍是唯一播放器和角色表现状态所有者。

角色接入 MCP 与兼容 HTTP 的完整 `PerformancePlan` 接口是直接角色控制和调试入口，不是
新的多 Agent reply 数据面。

## 两层框架

### AgentConnectionManager

连接管理层负责：

- 注册 `agentId + instanceId`；
- Char reply 能力和最大并发额度；
- endpoint 生命周期、健康状态和 AbortSignal；
- 在可用实例间路由任务；
- 返回实际执行实例及带 task/attempt 相关性的结果。

它不持有 ConversationLedger、Turn 顺序或 ResponseSlot。

### ConversationRuntime

任务编排层负责：

- 追加不可变用户消息并创建 Turn；
- 在创建 Turn 时编译本次 Char reply task 的对话与 Persona 快照；
- 并发分派多个 Turn；
- 校验 `conversationId + turnId + taskId + attemptId`；
- 收到 sealed 文本后立即扇出 TTS/表现准备任务；
- 按 Turn 顺序提交 assistant 消息；
- 在准备完成后按 Turn 顺序调用单消费者 PresentationPort。

后台任务不直接修改 ResponseSlot。异步完成、失败和取消都必须回到 Runtime，由 Runtime
更新只读 Snapshot 并推进下一步。

## 最小实现与非目标

首个框架位于 `packages/conversation-runtime`，提供：

- 内存 Agent 注册和容量路由；
- 单 conversation 的跨 Turn reply 调度；
- reply、speech、performance、commit、presentation 正交状态；
- 提前准备和有序提交/播放；
- generation/attempt 相关字段与 AbortSignal；
- 可替换的 reply endpoint，以及生产前台使用的单进程 Codex App Server client。

首版暂不包含持久化、Context patch、流式 token/segment、失败自动迁移和语义
supersede/rebase。新用户输入增加 Ledger revision 时不会自动使运行中的旧 Turn 失效；
Persona 改变、明确取消、generation 变化或 deadline 到期才硬拒绝结果。本阶段不加入
专家 Agent 或同一 Turn 多候选。

首版也不执行 Turn 重试。Char 请求超时、断开或返回非法结果时，应用在原 ResponseSlot 中
记录错误，并 sealed 一条来自 `application-fallback` 的预设角色通知，例如“上一轮的回复
没有收到，可以再说一次吗？”。该 fallback 继续经过正常 TTS/表现准备、顺序提交和播放，
随后放行已经准备好的后续 Turn。失败诊断不伪装成 Agent 输出；更智能的重试、endpoint
迁移和无感失败恢复留到后续阶段。

## Electron 前台验证入口

左键角色打开共享交互面板。面板顶部包含两个一级分类：

- `角色对话`：默认页，提供多行输入框和发送按钮；Enter 换行，Ctrl+Enter 发送；
- `资源调试`：保留原有表情、动作、Neutral/Reset 与基准姿态锁定能力。

当前桌面端按 `agentRoles.char.maxConcurrency` 注册 1–8 个容量均为 1 的逻辑 endpoint，
默认 `char-worker-1`、`char-worker-2`。所有
endpoint 通过 Electron main 共享一个官方
`codex app-server` 进程，不为每个助手或每个 Turn 启动独立 CLI。每次回复请求在该
进程内建立独立 ephemeral thread，并通过 `turn/start` 的 JSON `outputSchema` 得到结构化
回复；应用的 ConversationLedger 仍是规范上下文。

输入可以连续提交；前台同时显示每个 Turn 的 `reply / speech / expr / play` 状态，因此
可以直接观察后提交的 Turn 先完成后台准备、但 Presentation 仍等待前序 Turn 的行为。
处理中最多保留 6 个未完成 Turn，且资源调试按钮暂时禁用，防止手动预览和正式播放争用
Avatar Runtime。消息列表仅在原本位于底部时自动跟随；用户手动向上滚动后，状态刷新
保留当前位置。

当前 Electron 接线刻意分为两个阶段：

1. sealed 文本到达后，`ConversationRuntime` 立即并行执行 speech/performance preparation；
2. 轮到该 Turn 呈现时，单消费者 `PresentationPort` 才把文本计划提交给
   `AvatarRuntime`，由已有 TTS、表情和动作链路实际合成并播放。

现阶段 preparation 只验证 TTS 服务健康状态并生成带 provider 的 handoff 标记，表现准备
也只记录 provider；它们还不是可直接复用的已合成音频或最终 `PerformancePlan`。因此该
入口已经验证多 Agent 调度、状态投影和顺序播放，但不应被描述为“播放前已经完成真实
TTS/表情推理”。下一步可以扩展 PreparationPort 的产物类型，并让 AvatarRuntime 接收
prepared artifact，在不改变 Turn/ResponseSlot 状态机的前提下实现真正的提前合成。

浏览器前台没有 Electron IPC 和 Codex App Server，使用按配置数量创建的确定性回显
endpoint，自动化默认使用两路并故意让后一个
Turn 更早 sealed，供自动化稳定验证调度顺序。

运行专用前台回归：

```powershell
npm run test:conversation-ui
```

该命令构建网页前台、加载真实 Live2D Core/Mao 资源并验证：

- 默认打开 `角色对话`；
- 后一 Turn 能先完成 speech/performance preparation；
- Presentation 顺序仍为 `0 -> 1`；
- `资源调试` 仍列出 8 个 expression、8 个 motion，并可切回对话页。

## Codex App Server 管理

官方 App Server 是面向自定义富客户端的长期 JSON-RPC 接口：单一连接先执行一次
`initialize`，随后可以用 `thread/start`、`turn/start` 管理多个会话并接收流式事件。当前
Electron 集成使用 stdio JSONL：

```text
DesktopChar main
  └─ codex app-server --listen stdio://       # 一个共享进程
       ├─ ephemeral thread: char-worker-1 / Turn N
       └─ ephemeral thread: char-worker-2 / Turn N+1
```

每个 thread/turn 均设置 `approvalPolicy: never` 和只读 sandbox；窗口关闭时 main 先
Abort 活跃 Turn，再统一关闭 App Server。Windows 下可通过
`agentProviders.<name>.launcherScript` 指向 WorkAssistant 的
`start_openai_codex.bat`：适配器读取该启动入口同目录的 UTF-8 `config.json`，
沿用其中的 `command/args` 启动 App Server，不直接解析原生 `codex.exe`，且不请求隐藏
子进程。

`agentRoles.char.maxConcurrency` 是整数并发上限，不是 checkbox。旧
`conversation.maxAssistants` 不作为兼容别名；schema、示例配置、快照、UI 和测试均已同步
迁移。配置热重载时，如果仍有回复或播放任务，只记录目标值；等 Conversation 空闲后再
增减逻辑 endpoint，不中断现有 Turn。

当前生产 Char Provider 只有 `managed`：DesktopChar 只拥有一个 Codex App Server，
所有逻辑 Char worker 共享该进程，并以独立 ephemeral thread 隔离每次任务。此前探索的
External Reply Agent 注册、租约和 callback 数据面不再保留；它既会增加生命周期与鉴权
复杂度，也不能比 App Server 更好地满足“受控多次对话请求”。

`ConversationReplyGateway` 继续统一输入/输出审计和 Renderer IPC。前台“连接与请求”区
显示实际 Provider、输入、回复和错误。Router 已在 `character` 与具体
`task-session` 之间选择：角色目标复用这里的 Char Agent Pool 和 ConversationRuntime；
session 目标进入 Task Manager 并默认立即提交。Task Manager 按 session 维护
submission generation，只把最后一次提交后恢复 `waiting_input` 的稳定结果作为完成事实。
两条目标链路共享消息入口与审计，但 Task Manager 命令不复用 CharReplyTask，见
[Task Manager 与会话路由设计](task-manager-routing.md)。

运行单进程、双 thread 的真实官方服务验收：

```powershell
npm run test:codex-app-server
```

该验收复用本机 Codex 登录状态，会产生实际模型调用；不进入默认 `npm test`。

运行完整 Electron 前台输入到 managed Codex 再回到对话面板的验收：

```powershell
npm run test:conversation-codex-foreground
```

该命令启动真实桌面窗口，在“角色对话”页提交一条消息，核对 gateway 审计中的
`codex-app-server` 完成记录，并确认相同回复已经由 `ConversationRuntime` sealed 后显示。
它同样会产生实际模型调用，不进入默认 `npm test`。

## 独立 Codex CLI 适配器

测试适配器调用官方 `codex exec` 非交互模式：

```text
codex exec
  --ephemeral
  --sandbox read-only
  --ignore-user-config
  --output-schema <reply-schema>
  -C <workspace>
  <reply-task-prompt>
```

当前 Windows 验收使用的 Codex CLI `0.145.0` 需要把全局审批参数放在子命令前，即
`codex --ask-for-approval never exec ...`；适配器按该兼容顺序组装参数。
Windows 下 Node 不能可靠地无 shell 启动 npm 生成的 `codex.cmd`，适配器因此解析该官方
npm 安装中的 `@openai/codex/bin/codex.js` 并通过当前 Node 进程直接执行；不会把对话文本
拼入 `cmd.exe` 或 PowerShell 命令字符串。

适配器只读取符合 JSON Schema 的最终回复，不使用 Codex 的会话历史作为规范上下文。
每次任务由应用显式注入 ContextEnvelope，并使用临时会话，保证跨 Turn 状态仍由
ConversationRuntime 持有。CLI 进度输出在 stderr，结构化最终回复在 stdout。

运行纯内存回归：

```powershell
npm run test:multi-agent
```

保留的包级替换适配器仍可运行两个独立 `codex exec` endpoint，用于验证
`AgentConnectionManager` 不依赖 App Server；它不是 Electron 生产接线：

```powershell
npm run test:codex-agent
```

该验收复用本机 Codex 登录状态，会产生实际模型调用；它必须使用只读 sandbox，不进入
默认 `npm test`。

## 轻量 Char Agent 与 MCP 测试

模块拆分不能迫使默认测试启动整套 DesktopChar。目标测试结构为：

```text
纯单元测试
  ConversationRuntime -> FakeCharAgent

MCP 契约测试
  Official MCP Client -> char_generate_reply -> FakeCharAgent

真实 smoke
  CharAgentEndpoint -> managed Codex App Server
```

`conversation-runtime` 只依赖 `CharAgentEndpoint`，不导入 MCP SDK。初期测试用
`CharAgentMcpAdapter` 只映射一个 `char_generate_reply` 工具及
`CharReplyTask/CharReplyResult` 的 schema、UTF-8、取消、超时和错误；它与现有负责
状态、`PerformancePlan` 和中断的 `characterMcp` 不是同一接口。

默认测试直接注入确定性 Fake；`test:char-mcp` 使用随机 loopback 端口和官方 MCP Client，
但不调用真实模型；真实 managed Provider 继续使用独立 smoke 命令，不进入默认
`npm test`。另保留只传文本、由脚本装配固定 Persona fixture 的一条手动命令，确保复杂
模块仍有简单可重复的 Char 调用入口。Char MCP 不作为生产 Provider，也不在首版契约完成后
继续增加流式、发现、配置或生命周期能力；后续只做保持测试可用的兼容修复。

## 2026-07-28 验收

- 纯内存回归使用两个受控 reply endpoint（目标命名为 Char worker），强制第二个 Turn
  先返回；后续 Turn 的 speech/
  performance 准备立即启动，但 commit 保持 blocked，最终提交和 Presentation 顺序均为
  `0 -> 1`。
- 官方 Codex App Server 验收由一个共享进程同时处理两个 ephemeral thread，分别返回
  “助手一就绪”和“助手二就绪”。
- 浏览器前台专用回归已验证“后一 Turn 先准备、前一 Turn 先播放”，并验证角色对话/
  资源调试分类切换、Enter 换行/Ctrl+Enter 发送，以及用户向上滚动后不被强制置底；
  真实桌面端通过相同 Renderer UI 改由 Electron IPC 调用单个 Codex App Server。
- `npm run check` 覆盖类型检查、196 个 TypeScript 包测试、12 个 Local TTS MCP 测试、
  64 个桌面 Electron 测试、Win32 native bridge 和生产构建。
