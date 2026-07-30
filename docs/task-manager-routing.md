# Task Manager 与会话路由设计

## 当前结论

跨项目任务通知不应扩展为 External Reply Agent。三个边界明确分开：

```text
Session Monitor
  原始 session 状态、可见文本、精确输入接口
           |
           v
Task Manager（独立常驻服务、确定性）
  轮询 / 去重 / 游标 / 事件日志 / 命令执行
           |
           v
DesktopChar
  原始输入/事件 + 用户可见时间线
           -> Router Agent
           -> Char Agent，或经确认进入已有 session
           -> TTS / 表情 / 动作 / 播放，或 TaskCommand
```

- 多 Turn 角色回复：DesktopChar 内部使用一个 managed Codex App Server，不连接用户 CLI；
  多个 Char Agent worker 只并行处理不同 Turn，全部使用同一个角色的完整 Persona。
- Task Manager：不使用 LLM；只发现和监控 session、保存有界状态与命令记录、发布事实事件并
  执行确定命令。它不积累完整对话、不生成摘要，也不创建结果文档。
- Router Agent：当前只在“交给桌面角色”与“交给某个已有 session”之间选择，输出结构化
  建议，不产生副作用；未来可以扩展目标类型，但本阶段不预先实现。
- Char Agent：从完整角色上下文开始生成普通角色回复，也把有界任务完成事实组织为符合角色
  性格的通知、建议或追问；它不是对无角色回复进行末尾润色。
- Session Monitor：是 CLI 会话事实与输入能力的基础设施，不拥有 DesktopChar 的对话语义。

因此 “DeepSeek” 只表示 Router Agent 可以使用一份独立 Provider/Profile；它不是固定模型，
也不表示 Char Agent 必须使用同一 endpoint。

## Router 目标与分目标调度

当前 Router 契约只需要四种结果：

```ts
type RouteTarget =
  | { kind: 'character' }
  | { kind: 'task-session'; sessionId: string };

type RouteDecision =
  | { decision: 'route'; target: RouteTarget; confidence: number }
  | { decision: 'confirm'; candidateSessionIds: string[] }
  | { decision: 'no-match' };
```

本阶段只有一个桌面角色，不提供 `characterId`、`charAgentId` 或多角色候选。Router 选择的
是逻辑目标，不是具体执行实例；路由到角色后由 `AgentConnectionManager` 从同一角色的
worker pool 中选择空闲实例。

### InteractionMessage 与派生记录

所有用户输入和 Task Manager 有界事实事件先保存为不可变 `InteractionMessage`，再进行路由。
该名称遵循现有 `ConversationMessage`、`PresentationUnit` 等领域类型的命名方式，不使用
语言实现味道较重的 `Struct` 后缀：

```ts
interface InteractionMessage {
  messageId: string;
  sequence: number;
  origin: 'user' | 'task-event' | 'char' | 'system';
  text: string;
  createdAtMs: number;
  references: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
}
```

原始消息的 `references` 为空且正文不再修改。Router 通过 `messageId` 引用原始消息并另外
写入 RouteRecord；Char Agent 生成的新 `InteractionMessage` 以 `references` 指向一个或多个
原始消息，并可在自己的派生记录中附加通知类型、建议来源等额外信息。这样原文具有独立
审计记录，Char/Router 都不需要复制或覆盖它。

```ts
interface RouteRecord {
  messageId: string;
  selection: TargetSelection;
  decision: RouteDecision;
  visibleContextRevision: number;
  decidedAtMs: number;
}
```

### 半自动目标选择

桌面应用提供固定目标选择器：

```ts
type TargetSelection =
  | { mode: 'auto' }
  | { mode: 'direct'; target: { kind: 'character' } }
  | { mode: 'direct'; target: { kind: 'task-session'; sessionId: string } };
```

- `Char`：直接进入单角色 Char Agent Pool，不调用 Router Agent；
- `Session 1/2/3...`：来自 Task Manager 当前已连接 session 列表，直接进入对应 session；
- `Auto`：由 Router Agent 使用冻结的可见上下文判断角色或具体 session。

目标选择保持 sticky：用户选择 Session 2 后，后续消息继续直达 Session 2，直到主动切换为
Auto、Char 或其他 session。新事件和 Router 建议不能覆盖显式选择；只有一直选择 Auto 时，
Router 才逐条判断目标。

显式 session 在发送前仍要校验连接状态；目标已失效时不得静默切回 Auto 或改投其他
session，也不改变当前 sticky 选择。UI 保留该选择并显示可重试错误，由用户主动切换目标。
选择器应显示 `waiting-input/active/idle-unknown/unavailable` 等只读状态，但不把启发式状态
伪装成官方 CLI 状态。

### 主应用会话注册与所有权

Auto/Char/Session 选择器只展示 DesktopChar 主进程
`ConversationSessionRegistry` 中已注册的会话，不再把 Task Manager 发现的全部窗口自动暴露给
Router。注册表使用独立的应用级 `sessionId`，避免把 Codex `threadId`、Session Monitor
`sessionId` 和 UI 选择值混为同一个标识：

```ts
type ConversationSession =
  | {
      sessionId: `managed:${string}`;
      ownership: 'managed';
      threadId: string;
    }
  | {
      sessionId: `external:${string}`;
      ownership: 'external';
      sourceSessionId: string;
    };
```

- “新建”调用同一个 managed Codex App Server 的稳定 `thread/start`，但创建
  `ephemeral: false` 的持久 thread；后续显式选择该 Session 时一直向同一 thread 发送
  `turn/start`，活动 Turn 中的新补充使用 `turn/steer`。App Server 子进程使用
  管道 stdio；Windows 可配置 WorkAssistant `start_openai_codex` 入口作为启动 Profile，
  DesktopChar 从其同目录配置解析命令，不直接解析或绑定原生 `codex.exe`，也不再请求隐藏
  子进程。用户仍只在 DesktopChar 自身对话面板中管理逻辑 Session。
- “绑定”只从 Session Monitor/Task Manager 已发现且尚未注册的窗口列表中选择，以稳定
  `sourceSessionId` 建立 External 注册。首版不猜测当前前台窗口，也不依赖窗口激活顺序；
  标题、工作目录和启发式状态只用于帮助用户识别候选。
- Managed 会话由 DesktopChar 拥有。用户关闭时，主应用先中断活动 Turn，再调用
  `thread/archive` 并移除注册；归档而非永久删除，避免不可恢复的数据破坏。
- External 会话仍由外部应用/CLI 拥有。用户关闭时只移除 DesktopChar 注册，不向 Session
  Monitor 发送关闭窗口或结束进程的命令；原对话窗口保持运行，并重新出现在可绑定列表中。
- 会话消失时保留 External 注册但标记为 `unavailable`，不自动切换或投递；用户可以等待其
  恢复或主动断开。
- 新建、绑定和关闭成功后由用户动作决定 sticky 目标：新建/绑定自动选择该 Session，关闭/
  断开后切换到 Auto。Router 只能看到注册表中的会话，不能自动选择未绑定窗口。

首版注册表与 Task Manager 一样只在当前 DesktopChar 进程内存中保存。Managed thread 会
持久写入 Codex 会话存储，但应用退出时会按所有权归档；External 绑定关系不跨应用重启恢复。
注册表恢复、Managed thread 重新接管和 External 自动重绑统一标记为后续待设计，不阻塞当前
新建、连续发送、绑定和关闭闭环。

`RouteCoordinator` 是消息入口门面，内部区分直连与自动路由：

```text
accept InteractionMessage
 -> persist original
 -> freeze exposure snapshot
 -> direct target，或 RouterAgentPort
 -> character dispatcher，或 session dispatcher
 -> append RouteRecord
```

它不自己实现模型调用、Session Monitor 轮询或 Char 生成；这些仍通过端口委托，避免把
RouteCoordinator 变成同时持有所有领域状态的 God Object。

当前 `packages/interaction-routing` 已实现这层纯领域门面：原始用户消息先进入内存审计，
每次发送冻结可见 revision、`showing/shown` 投影和有界候选；显式 Char/session 保持 sticky
并绕过 Router。Auto 对明显高分候选直接路由、只对达到合理分数且领先幅度不足的接近候选
产生确认；弱且孤立的猜测收敛为 `no-match`。Provider 错误、未知 session、revision 不匹配
或非法结构抛出可区分的路由错误，均不会回退 Char 或产生 session 副作用。该领域门面现已
接入 Task Manager、前台 sticky 选择器和主进程 Router Provider；纯端口测试继续负责覆盖
阈值、确认、冻结 revision 与严格失败语义。

不同目标采用不同的并发规则：

| 目标 | 执行者 | 并发规则 | 上下文来源 |
| --- | --- | --- | --- |
| `character` | Char Agent Pool | 不同 Turn 可并行 | DesktopChar 显式编译的 Ledger、Persona 和场景快照 |
| `managed:{threadId}` | Codex App Server | 空闲时开始 Turn；活动时立即 steer 当前 Turn | DesktopChar 拥有的持久 Codex thread |
| `external:{sourceSessionId}` | Task Manager | 默认立即提交；以同一 session 最后一次提交后的最终回复为准 | 目标 CLI 自身持续维护的会话上下文 |

角色通道不等待前一轮模型完成：

```text
Turn N   -> Char Worker A ┐
Turn N+1 -> Char Worker B ├─ 并行生成和准备
Turn N+2 -> Char Worker C ┘
                         -> ConversationRuntime 顺序提交和播放
```

所有 worker 必须从任务 Envelope 得到相同版本的完整 Persona，不能依赖各自 Provider thread
积累角色历史。managed Codex App Server 可以复用一个进程，但每个并行 Turn 使用独立
ephemeral thread，规范上下文仍由 DesktopChar 持有。

已有 session 通道默认立即把补充说明提交给目标 CLI：

```text
Router/direct selection
 -> task-session:A
 -> Task Manager
 -> Session Monitor /input mode=submit
```

即使 A 正在生成上一轮回复，新请求也立即提交，满足“补充说明，只关心最后请求完成后的最终
回复”这一主要场景。Task Manager 为 A 递增 `submissionGeneration` 并重新开始完成观测；
旧 generation 的中间回复不单独通知 DesktopChar，A 在最后一次提交后重新稳定进入
`waiting_input` 时，才把最终可见回复作为本轮完成结果。

首版不实现“等待上一轮结束再提交”的串行策略，也不让 Router Agent 猜测时间调度方式。
如果以后出现少量严格串行任务，应由用户或调用方显式标记 `after-current`，作为 Task
Manager 的执行策略扩展；Router 继续只选择目标。session 关闭或 `/input` 失败时返回错误，
不自动改投其他目标。

`submissionGeneration` 只定义 Task Manager 的观测和通知边界，不能替目标 CLI 定义并发
语义。Session Monitor 返回 `submitted: true` 只证明文本和 Enter 已写入控制台输入队列；
目标 CLI 可能把它当作运行中补充、下一轮排队输入或普通终端输入。首版必须分别用实际支持的
CLI 验收 active 状态下的 `/input` 行为；Task Manager 只能承诺立即投递，以及不向
DesktopChar 发布旧 generation 的独立完成通知。

## Task Manager 服务边界

Task Manager 适合作为随系统或用户会话启动的常驻脚本/服务。它读取 Session Monitor
marker 和 token，并以 marker 中声明的 `capabilities.sessionInput` 为准；当前本机实现是
v4，客户端同时接受具有该能力的 v3+ marker。通过 loopback HTTP 使用：

- `GET /api/sessions`：读取会话摘要；
- `GET /api/sessions/{sessionId}`：按需读取当前状态与有界可见文本；
- `POST /api/sessions/{sessionId}/input`：向确定会话 `insert` 或 `submit` 文本；
- `GET /api/monitor/events`：辅助恢复监控游标和诊断。

Session Monitor 的 `/inbox` 只适合保存状态通知、摘要或 handoff，不会进入目标 CLI 对话，
因此不能作为 TaskCommand 的等待队列。首版 TaskCommand 一律直接调用 `/input`；Task
Manager 内部只保存命令日志和 submission generation，不额外延迟投递。

首版明确不做：

- 不调用 Router/Char 或任何其他 LLM，不理解自然语言目标；
- 不实现 mailbox 等待队列、定时发送或串行任务调度；
- 不拼接终端屏幕快照、恢复完整 transcript 或生成结果摘要；
- 不创建结果文档，不扫描目录猜测结果文件，也不自行决定打开任意路径；
- 不根据轮询结果自动向 session 发送补救、追问、中断或重试命令。

端口必须从 marker 的 `httpBaseUrl` 发现，token 只从 `httpTokenFile` 读取，不能写进仓库
配置或日志。`capabilities.sessionInput.enabled` 为真后才可使用 `/input`。该接口不要求
CLI 窗口位于前台，也不要求 `agentState == waiting_input`；`agentState` 基于可见终端文本
推断，只能作为启发式信号，不能当成 CLI 官方完成事件。

当前 Session Monitor 源码将终端尾部八行中出现以 `›` 或 `> ` 开头的行推断为
`waiting_input`；本轮屏幕发生变化但未看到提示符时为 `active`，屏幕稳定且没有提示符时为
`idle_unknown`。因此它可以支持首版保守轮询，但不能单独证明某个 command 对应的回复已经
完整结束。

Task Manager 对每个 session 维护命令日志、最新 `submissionGeneration` 和完成观测状态：

```text
每次提交前保存 visibleTextHash / lastScreenChangedAt
 -> 递增 submissionGeneration
 -> 立即 POST /input mode=submit
 -> 至少观察一次最新 generation 提交后的 hash / lastScreenChangedAt 变化
 -> 若又有新请求，立即提交并再次递增 generation
 -> 持续轮询 session 状态与有界文本尾部
 -> 最新 generation 之后观察 waiting_input 恢复并稳定
 -> 以最后一次有界可见文本采样完成最新 generation
```

已经处于 `active` 不能单独作为新 generation 已被 CLI 接受的证据；需要看到提交后的新屏幕
变化，再等待其恢复并稳定在 `waiting_input`。`idle_unknown` 不视为完成。轮询周期不应快于
marker 的 `intervalMs`。首版不处理回复被
用户中断的情况；若新请求在上一轮完成前提交，旧 generation 不再单独产生完成通知，完成
事件以最后一次提交后的稳定快照为准。由于 `lastVisibleText` 是有限长度的终端可见文本，
这只能提供保守的最终文本尾部，不能保证得到任意长回复的完整 transcript。Task Manager
只保留协议上限内的最新 `visibleTextTail`、hash、状态和观察时间，不跨轮询拼接文本，也不
尝试合并重叠屏幕内容。后续若 Session Monitor 提供正式 turn completion/correlation，
只替换完成事实来源，不扩大 Task Manager 的内容存储职责。

Task Manager 自身应提供窄领域接口，而不是把 Session Monitor 全量透传给 DesktopChar：

```text
GET  /health
GET  /sessions
GET  /events?after=<cursor>
POST /commands
POST /events/<eventId>/ack
```

事件至少携带 `eventId`、单调 cursor、`sessionId`、事件类型、观察时间、状态、来源
hash/revision、协议上限内的 `visibleTextTail` 和可选的已验证结果文档引用。Task Manager
保存命令、去重与 ack 状态，不保存无界原始结果；DesktopChar 保存收到的有界 payload 和
派生呈现记录。断线重连从最后 ack cursor 恢复，不能靠“最近一条文本”猜测是否已经通知。

首个跑通版本的命令日志、事件、cursor、ack、submission generation 和幂等集合都只保存在
内存中。DesktopChar 在同一次 Task Manager 进程生命周期内断线重连时可以继续使用 cursor/
ack；Task Manager 自身重启后不承诺恢复这些状态，也绝不自动重放旧命令。重启时重新发现
session，并把重启前仍在观察的 submission 视为不可恢复，不补发其完成事件。跨重启幂等、
事件保留、恢复检查点和持久化存储格式统一标记为后续待设计，不阻塞首个端到端流程。

当前 `task-manager/` 已落地上述内存版本：

- `session-monitor-client.mjs` 仅从显式 marker 路径读取 loopback 地址和 token 文件，验证
  `submit` capability；token 不进入快照、URL或日志；
- `task-manager-runtime.mjs` 立即提交精确命令；同 session 的新成功提交以递增 generation
  supersede 旧观察，乱序 HTTP 确认也不能把旧 generation 重新设为当前；
- 完成必须先观察提交后的 hash/时间变化，再连续两轮得到相同 `waiting_input` 快照；
  `active` 本身和 `idle_unknown` 均不构成完成；
- 中间采样不跨轮询拼接，事件只保存有界尾部；事件有单调 cursor 和幂等 ack，运行时状态、
  命令与事件不跨进程重启恢复；
- 声明结果文档在提交前校验允许根目录和路径逃逸，在完成时再次校验真实文件；Task Manager
  只回传路径与 `openOnCompletion` 意图，不创建也不打开文件；
- `http-service.mjs` 仅暴露 `/health`、`/sessions`、`/events`、`/commands` 和
  `/events/{id}/ack`，除 health 外均需 bearer token，且拒绝非 loopback 绑定。

真实 Session Monitor v4 的 marker/token、会话记录和独立 HTTP 服务启动已经完成只读验收；
尚未在受控测试 session 中执行真实 `/input submit`，因此 active 状态下各目标 CLI 的具体
补充/排队语义仍保留为后续实机验收项。

DesktopChar 的首要需求是知道事项是否完成，不要求 Task Manager 重建任意长的完整对话。
完成事件默认只携带有限信息：

```ts
interface TaskCompletion {
  sessionId: string;
  submissionGeneration: number;
  status: 'completed' | 'failed' | 'unavailable';
  title?: string;
  lastVisibleLine?: string;
  visibleTextTail?: string;
  resultArtifactPath?: string;
}
```

Char Agent 可以根据状态和短文本生成“某事项已完成”等辅助决策通知。需要详细结果的工作流
必须在提交命令时预先约定固定结果文档，由目标任务或配套脚本写入；Task Manager 只在完成
时验证已声明路径位于允许目录且文件存在，再把 `resultArtifactPath` 交给 DesktopChar。
Task Manager 不从终端文本推断路径，也不负责创建或打开文档。是否由 DesktopChar 自动打开
必须由本次命令中的显式选项决定。

命令必须已经消除歧义：

```ts
interface TaskCommand {
  commandId: string;
  sessionId: string;
  text: string;
  mode: 'submit';
  contextRevision: number;
  resultArtifact?: {
    path: string;
    openOnCompletion: boolean;
  };
}
```

Task Manager 不接受 `target: "之前那个项目"`、候选列表或自然语言路由指令。它校验
session 仍存在、命令幂等键未执行，并在存在 `resultArtifact` 时先校验声明路径属于配置
允许目录，再调用 Session Monitor。完成时只重新验证同一路径，不扫描相邻文件。状态轮询
本身永远不能触发 `/input`；只有用户已授权且 DesktopChar 已确定目标的命令可以产生副作用。

## 用户可见时间线

路由依据必须是用户实际可能感知的信息，而不是后台流水线的最新状态。DesktopChar 将生成/
准备状态与暴露状态分开：

```text
后台：received -> transformed -> preparing -> queued -> presenting -> completed
暴露：hidden -> showing -> shown
```

Router 使用的投影至少包含：

```ts
interface MessageExposure {
  messageId: string;
  phase: 'showing' | 'shown';
  visibleText: string;
  complete: boolean;
  exposureRevision: number;
}
```

- `showing` 已参与 Router；只提供此刻真正显示给用户的 `visibleText`，不能泄露尚未显示的
  完整正文；
- `shown` 表示完整信息已经显示，不表示能够推断用户确实读完；
- 用户阅读速度不可可靠估计，刚开始显示就发送的回复仍可能引用当前可见前缀；
- 后台收到、Char 已生成但仍完全不可见、仅排队或被抑制的内容不进入 ExposureProjection；
- `complete/direct` 显示模式在完整正文渲染后立即提供全文并记为 `shown`；
- `stream` 与 `karaoke` 根据当前文本 cue、播放位置或已有字符速率回退估算
  `visibleText`，在进度完成前保持 `showing`；KTV 未到达的后续文本不作为当前可用上下文；
- 如果调试 transcript 在 commit 时立即显示完整正文，该显示渠道已经使消息成为 `shown`，
  不能再因语音仍在播放而降回 `showing`。

用户按下发送时冻结 `visibleContextRevision` 与所有当前 MessageExposure。即使 Router
推理期间又显示更多文本，本次判断仍使用冻结快照，避免目标在发送途中漂移。

## Router Agent 输入与决策

Router Agent 不需要完整 `SessionRoutingContext`。输入保持为用户可理解的最小场景：

- 当前 `InteractionMessage`；
- 最近约 8–12 条 `showing/shown` 用户可见投影；
- 最近约 3–6 个候选任务的标题、简短摘要、状态和最后用户可见事件；
- 用户显式选择的会话（若有）；
- 尚待用户确认的路由建议（若有）；
- 冻结的 context revision。

候选集合采用 LRU/相关性混合维护，不能只保存“最后一个 session”。LRU 的更新时间来自
用户显式发送或消息开始/继续真实显示；后台收到但仍为 `hidden` 的事件不更新用户可见活跃
顺序。Router 仍读取冻结的 ExposureProjection，不从 LRU 顺序单独推断目标。

Router 模型输出在 `RouteDecision` 外附带冻结 revision 和候选评分：

```ts
interface RouterAgentResult {
  contextRevision: number;
  route: RouteDecision;
  candidates: Array<{
    sessionId: string;
    score: number;
    reason: string;
  }>;
}
```

- 纯角色对话页、没有外部候选等明确场景直接路由 `character`，不调用模型。
- 用户显式选择 session 时，确定性规则优先，不必调用 Router。
- Auto 是用户显式选择的自动路由模式。单个 session 候选同时达到配置的最低置信度，且相对
  第二候选的领先幅度达到配置阈值时，DesktopChar 可以直接提交到该 `task-session`。
- 只有存在多个合理候选、但没有明显高概率领先者时才返回 `confirm`；DesktopChar 列出少量
  候选并等待用户二次确认。没有合理 session 候选时不为了确认而展示无关 session。
- 没有足够相关的 session 候选但输入明显是普通角色对话时返回 `character`；无法判断输入
  是否应产生外部副作用时返回 `no-match`，不得发送。
- Router 只能引用输入候选中的 `sessionId`，不能生成新 ID，也不能直接调用 Task Manager。
- 用户确认后要重新校验 session 状态和 context revision，再生成唯一 `TaskCommand`。
- Router 调用超时、Provider 错误或结构校验失败时直接向前台返回路由错误，不回退 Char，
  不改写为 `no-match`，也不产生任何 session 副作用。`no-match` 是正常决策，前台提示用户
  改写输入或显式选择目标。

示例：

1. 用户最后一次明确发给 B；A 的通知仍在合成或排队、尚未产生可见文本，此时“继续”仍
   路由 B。
2. A 正在显示且用户已看到“A 已完成”等前缀后立即回复，该 `showing` 投影必须参与判断，
   Router 可以把 A 作为候选，不等待完整播放。
3. A 的通知完整显示后，用户说“继续”，用户可见的最近话题已是 A，默认候选转为 A。
4. 用户说“继续之前那个项目”，Router 必须结合可见历史和多个 LRU 候选评分；仍有两个
   接近候选时询问用户，不发送。
5. 用户在界面显式选择 B 后输入“继续”，直接使用 B；新到达或正在显示的 A 不能覆盖选择。

## 单角色 Char Agent 契约与时效性

当前实现使用单角色 `CharAgentEndpoint`，从任务开始就携带角色上下文，而不是在通用回复
之后再增加一次角色润色：

```ts
interface CharAgentEndpoint {
  execute(task: CharReplyTask, signal: AbortSignal): Promise<CharReplyResult>;
}

interface CharContextEnvelope {
  schemaVersion: 'desktop-char.char-context.v1';
  baseContextRevision: number;
  personaRevision: number;
  persona: PersonaProjection;
  messages: readonly ConversationMessage[];
  focusMessageId: string;
}

interface CharReplyTask {
  conversationId: string;
  turnId: string;
  taskId: string;
  attemptId: string;
  generation: number;
  deadlineAtMs: number;
  context: CharContextEnvelope;
}

interface CharReplyResult {
  conversationId: string;
  turnId: string;
  taskId: string;
  attemptId: string;
  generation: number;
  baseContextRevision: number;
  personaRevision: number;
  segments: readonly ReplySegment[];
}
```

`CharReplyTask` 外层只负责调度关联、generation 和 deadline；首版已需要的 Persona、消息与
revision 从一开始收拢到 `context`，不继续平铺字段。这个封装不增加或减少发送给 Char 的
信息，也不改变运行语义；Provider Adapter 只需从 `task.context` 读取原有内容。
`focusMessageId` 必须指向 `context.messages` 中唯一存在且 `role == 'user'` 的本 Turn
消息，Adapter 使用该消息正文替代旧的平铺 `userMessage`；任务创建和入口校验同时保证该
不变量。

首版 `CharContextEnvelope` 不是通用 `AgentContextEnvelope` 的完整实现，不增加 summary、
scene、memory、上下文 manifest hash、自动语义 rebase 或多候选仲裁。结果只需回传生成时
使用的 `baseContextRevision` 与 `personaRevision`，并继续使用现有
task/attempt/generation 关联。这些关联字段由 Provider Adapter 从请求复制到结果，模型只
生成文本 segment。后续如果需要 summary、scene 等信息，应先重新设计
`CharContextEnvelope` 的内部投影或参考通用 `AgentContextEnvelope` 重构，不把新字段重新
平铺到 `CharReplyTask`。

Char Agent 运行期间有新用户输入进入 Ledger，会自然产生更高 revision，但不会使先前回复
立即失效。只要原 Turn 未取消或 supersede、generation 仍匹配、Persona 未改变且未超过
deadline，就接受它基于派发快照生成的结果。当前最新 Ledger revision 不要求与
`baseContextRevision` 相等。Persona revision 改变、明确取消或超时才是硬失效条件。

## Char Agent 与 Router Agent 独立配置

WorkAssistant 的 `start_*_agent` 启动器已经验证了可复用模式：每个 Agent 可以独立选择
命令、模型、base URL、工作目录、初始 prompt 和隔离的运行环境；包装启动器只选择具体
entry script，不把 Provider 设置写入全局配置。DesktopChar 后续采用相同原则，但拆成
“可复用 Provider Profile + Agent 角色绑定”，避免每个角色复制整份连接信息。

下面是当前已经支持的 Agent 配置形态：

```json
{
  "agentProviders": {
    "codex-managed": {
      "adapter": "codex-app-server",
      "lifecycle": "managed",
      "requestTimeoutMs": 180000
    },
    "router-deepseek": {
      "adapter": "openai-compatible",
      "baseUrl": "https://provider.example/v1",
      "model": "router-model",
      "apiKeyEnv": "DESKTOP_CHAR_ROUTER_API_KEY",
      "requestTimeoutMs": 8000
    }
  },
  "agentRoles": {
    "char": {
      "provider": "codex-managed",
      "promptProfile": "profiles/char/default.json",
      "maxConcurrency": 2
    },
    "router": {
      "provider": "router-deepseek",
      "promptProfile": "profiles/router/session-routing.json",
      "temperature": 0,
      "autoSubmitMinConfidence": 0.85,
      "autoSubmitMinMargin": 0.15,
      "maxTimelineEntries": 12,
      "maxCandidates": 6
    }
  }
}
```

配置规则：

- Char 与 Router 的 Provider、模型、base URL、超时、温度和 prompt profile 均可独立；
- 独立配置不等于必须启动两个进程，同一 Provider Adapter 可以按 profile 复用连接池；
- 所有并行 Char worker 绑定同一角色 Profile 和 Persona revision，不表示不同人格；
- Router 可选择低延迟、稳定结构化输出的远程轻量模型；DeepSeek 只是候选而非硬编码依赖；
- `autoSubmitMinConfidence` 和 `autoSubmitMinMargin` 由确定性的 RouteCoordinator 使用，
  Router 模型不能自行降低阈值；低于任一阈值且存在多个合理候选时进入二次确认；
- Char 可以使用更强模型，且只接收生成角色化表达所需的有界事实事件和 Persona 投影；
- role binding 不直接包含密钥；只允许 `apiKeyEnv` 或后续 `secretRef`；
- managed 子进程只获得自身所需的 child environment，可按 Provider 使用隔离的配置目录；
- 任何启动脚本、示例 JSON、审计快照和前台状态都不得输出 token 或 API key；
- Profile 热重载只影响新请求；已经冻结的路由决策和正在呈现的通知继续使用原 revision。

Char 与 Router 的 Provider/Profile 分层、脱敏快照和配置测试均已落地。生产 Char 固定
使用 managed Codex App Server；默认 Router 也使用 managed Codex，并与 Char 共享同一
进程、按请求建立独立 ephemeral thread。Router 还支持 OpenAI-compatible Provider：
应用 JSON 只保存 `apiKeyEnv`，密钥值在请求开始时从环境读取，不进入快照或日志。
`profiles/router/session-routing.json` 每次新请求开始时重新读取，已开始的请求继续使用冻结
Profile。Provider 边界使用 Codex 严格 Schema 支持的扁平判别结构，主进程再还原为项目内
`RouteDecision` 联合类型。旧 `conversation.maxAssistants` 已一次性迁移为
`agentRoles.char.maxConcurrency`，根级 `routing` 也已迁入 `agentRoles.router`，均不保留
同义字段。

## 轻量 Char Agent MCP 测试面

现有 `characterMcp` 是 DesktopChar 对外提供状态、能力、`PerformancePlan` 和中断的角色
控制 Server，不是 Char Agent 文本生成接口。Char Agent MCP 只作为初期契约测试 Adapter，
不是生产 Provider，也不把 MCP SDK 引入 `conversation-runtime`。

Char Agent MCP 首版只需要一个 `char_generate_reply` 工具，输入输出与
`CharReplyTask/CharReplyResult` 一一对应。测试分三层：

1. 默认单元测试直接注入确定性 `FakeCharAgent`，覆盖并发、顺序、revision、超时和取消，
   不启动网络、Electron、TTS 或模型。
2. `test:char-mcp` 使用官方 MCP Client、随机 loopback 端口和 Fake endpoint 验证 schema、
   UTF-8、错误与取消；进入默认检查但不调用真实模型。
3. 真实 managed Codex/Char Provider 只由独立 smoke 命令调用，不进入默认 `npm test`。

另保留只传一段文本的手动 smoke 脚本，由脚本装配固定 Persona fixture 和 revision，使模块
继续拆分后仍能用一条命令确认 Char MCP 契约，而无需启动 Router、Task Manager、TTS 或
Live2D。首版测试契约完成后不再把 Char MCP 扩展为正式 Provider，不增加流式回复、Provider
发现、生产配置或生命周期管理；后续只做维持现有测试可运行所必需的兼容修复。

## 处理链路

Task Manager 有界事实事件：

```text
Session Monitor observed change
 -> Task Manager de-duplicate and emit bounded fact event
 -> DesktopChar store bounded fact event
 -> RouteCoordinator
 -> character（默认通知路径）
      -> Char Agent produce character notice + optional suggestion
      -> local performance planning and TTS prepare
      -> single PresentationQueue
      -> presentation-completed
      -> append visibleTimeline and update candidate LRU
 -> task-session（仅在已有明确授权/确认时）
      -> Task Manager immediate submit
```

用户回复：

```text
user input
 -> freeze visibleContextRevision
 -> explicit target rule, otherwise Router Agent
 -> character / task-session / confirm / no-match
 -> character: Char Agent Pool -> ConversationRuntime
 -> task-session: optional confirmation -> Task Manager immediate submit
 -> TaskCommand(sessionId, original text, submit)
 -> Task Manager -> Session Monitor /input
```

Char Agent 的建议只是用户可见内容，不自动转化为 TaskCommand。Router 的高分判断也只是
提议；只有确定性目标、既有显式授权或用户确认后，DesktopChar 才能向已有 session 发送。
这避免 Task Manager 事件在 session 之间形成未经用户确认的自动转发环。

## 实施顺序

1. （已完成）把过渡的 Reply 契约收窄为单角色 `CharAgentEndpoint`，保持 Fake 注入、轻量
   MCP 契约测试和现有 managed Codex 实现。
2. （已完成）增加 Router 领域端口和确定性快速路径，只实现
   `character/task-session` 两类目标；Provider 与前台接线留在后续步骤。
3. （已完成）实现 Task Manager 的 marker/token 发现、Session Monitor 轮询、内存有界事实
   事件日志、cursor/ack、按 session 的 submission generation 和精确命令接口。
4. （已完成）DesktopChar 接收并保存有界事实事件，保存后 ack，并以不含终端尾部的固定文案
   完成无 Agent 的确定性通知与 Avatar Runtime/TTS 播放闭环。
5. （已完成）增加 `VisibleRoutingContext`、候选 LRU、冻结 revision，以及现有对话框中的
   sticky Auto/Char/Session 选择、候选状态和二次确认区域；Router Provider 失败时严格
   报错，不回退到 Char 或任意 session。
6. （已完成）实现 Char Agent 的角色化任务通知：只把标题、状态和结果文档可用性编译到
   `CharReplyTask`，不传终端尾部或绝对路径；每个任务 Turn 使用对应固定短句作为应用
   fallback，有界原始事件继续保留在 DesktopChar main 快照中供审计。
7. （已完成）补齐 Router Provider/Profile/Agent Role、`apiKeyEnv` 密钥引用和新请求边界
   热重载；main 通过窄 IPC 提供结构化决策与取消，managed Router/Char 共用一个 App Server。
   前台 smoke 已验证 sticky Session、Provider 严格失败、配置热切换、真实 Codex Auto 路由
   和随后 Char 回复。
8. （已完成）在 DesktopChar main 增加内存 `ConversationSessionRegistry`，统一 Managed 与
   External 会话 ID 和所有权；对话框可新建持久 Codex thread、从已发现窗口绑定 External
   会话，并按所有权执行归档关闭或仅断开。Router 候选只包含已注册会话；前台 smoke 同时
   验证绑定、sticky 路由、Managed 新建/归档及 External 断开不关闭源窗口。
