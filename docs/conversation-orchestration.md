# 对话上下文与任务编排设计

## 设计结论

DesktopChar 应用持有规范对话上下文、Agent 任务状态和唯一呈现队列。外部 Agent 是可替换的计算执行者，不是对话事实、角色人格、回复顺序或播放器状态的所有者。

```text
Desktop / Voice / Scene Interaction
                  |
                  v
        Conversation Runtime
  Ledger -> Context Compiler -> Turn Scheduler
                  |                  |
                  |          Agent Task(s)
                  |                  v
                  |        Agent Router / Adapters
                  |                  |
                  +<-- Candidate Result(s)
                  |
           Response Committer
                  |
          accepted PerformancePlan
                  v
        Avatar / Presentation Runtime
    Performance Queue -> TTS -> Player facts
```

单 worker 只作为并发额度不足或调度故障时的降级，不作为高频桌面交互的目标形态。上下文、
任务和提交协议按多个 Char Agent worker 建模，目标架构验收必须覆盖至少两个 worker 对不同
Turn 的并发任务、乱序返回、取消和唯一提交。所有 worker 都服务同一个桌面角色，获得完整且
同版本的 Persona；并行不表示不同角色、不同人格或同一 Turn 的多候选仲裁。表情和动作继续
由本地表现模型处理。它不能改变“规范上下文由应用持有、用户可见回复单写提交、实际呈现由
应用仲裁”的边界。

多 Agent 子系统按两层实现：

1. `AgentConnectionManager` 是连接管理层，持有逻辑 Agent 实例、能力、健康状态、
   endpoint 适配和并发额度。它只负责把任务交给可用执行者并返回带相关性的结果，不判断
   Conversation 顺序，也不能调用 TTS、表现模型或播放器。
2. `ConversationRuntime` 是回复任务编排层，持有 Ledger、Turn、reply task、ResponseSlot
   和单写提交状态。它接收 Agent 结果、校验 attempt/generation，把 sealed 文本尽早扇出到
   TTS 与本地表现准备队列，并以独立的顺序屏障推进正式提交和播放。

从并发模型看，这是“多生产者、单提交者”：Agent、TTS 和本地表现推理都可以并行完成，
但所有完成事实只能作为事件回到 `ConversationRuntime`。实现不依赖多个工作线程直接共享
可变 ResponseSlot，也不允许后台任务自行推进 AvatarRuntime。

这里的“应用持有”不表示把全部职责塞入现有 `AvatarRuntime`：

- `ConversationRuntime` 是对话消息、上下文 revision、待处理 Turn 和 Agent Task 的唯一所有者；
- `AvatarRuntime` 继续是角色表演、聊天气泡、口型、动作和中断 generation 的唯一所有者；
- `SceneRuntime` 继续拥有 Scene Actor 与关系状态；
- Electron main 持有 endpoint、连接、超时等基础设施状态，但不持有另一份对话事实；
- UI、Agent Adapter、TTS、Player 和持久化 Adapter 只提交事件或执行 Effect。

多个领域 Runtime 可以由应用层 Coordinator 编排，但同一份状态不能由两个模块复制持有。

应用层后续使用 `DesktopCharRuntime` 作为组合根。它只负责装配、路由跨领域事件和生成统一只读视图，不复制任何领域状态：

```text
DesktopCharRuntime（组合根）
├─ ConversationRuntime
│  ├─ ConversationLedger
│  ├─ ContextCompiler
│  ├─ TurnScheduler
│  ├─ ResponseQueueRuntime
│  └─ ResponseCommitter
├─ AgentConnectionManager
├─ SceneRuntime
└─ AvatarRuntime（角色领域门面）
   ├─ PerformanceRuntime
   ├─ SpeechRuntime
   ├─ SpeechBubbleRuntime
   ├─ GazeRuntime
   └─ LipSyncRuntime
```

跨领域协作必须通过有类型的事件完成。例如 `response.committed` 可以请求
`AvatarRuntime` 接受一个 `PerformanceUnit`，`performance.completed` 再向
`ConversationRuntime` 报告呈现完成；组合根不能直接修改任一子 Runtime 的内部字段。
Char reply task、attempt 和 ResponseSlot 属于 `ConversationRuntime`；连接、进程和 endpoint
并发属于 `AgentConnectionManager`。两者通过 `CharReplyTask` 与 `CharReplyResult` 契约
协作，任何一层都不能拥有第二份对话记录。任务的 Persona、消息和 revision 已收拢到
嵌套 `CharContextEnvelope`，Runtime 内部的 reply 状态名继续保留。

## “完整上下文”的准确含义

应用保存的是可追溯的规范上下文，而不是在每次 Agent 请求中无限附加完整历史。上下文分为：

```text
Character Persona（版本化强设定）
+ Long-term Memory（确认后的长期记忆）
+ Conversation Summary（旧消息的规范摘要）
+ Recent Messages（近期完整消息）
+ Pending User Messages（尚未被回复覆盖的消息）
+ Scene Projection（按任务需要投影的场景事实）
```

`ConversationLedger` 以不可变事件保存原始事实：

- 每条消息具有稳定 `messageId` 和单调递增 `sequence`；
- 消息写入后不因自动合并、摘要或 Agent 重试而改写；
- 用户输入先进入 Ledger，再异步创建任务，因此输入框不受 Agent、TTS 或播放状态阻塞；
- Agent 回复只有经过 `ResponseCommitter` 接受后才写成正式 assistant 消息；
- 被取消、过期、拒绝和未采用的候选结果保留诊断状态，但不能伪装为已发生的对话。

`ContextCompiler` 从指定 revision 编译有界的 `ConversationSnapshot`。它负责 token/字符预算、摘要、隐私范围和 Agent 角色投影；Agent 的隐藏会话缓存只能作为性能优化，不能成为恢复上下文的唯一来源。

持久化存储保存 Ledger、摘要、Persona revision 和必要的调度检查点。存储 Adapter 不是状态所有者；重启恢复时必须通过已提交记录重建 ConversationRuntime。

## 上下文总结与压缩

总结是从不可变 Ledger 派生的、可回滚的缓存记录，不是对历史消息的覆盖写。每份规范摘要至少保存：

```ts
interface ConversationSummaryRecord {
  summaryId: string;
  conversationId: string;
  covers: {
    fromSequence: number;
    toSequence: number;
    messageIds: string[];
  };
  baseContextRevision: number;
  personaRevision: number;
  summaryRevision: number;
  sourceDigest: string;
  content: {
    facts: string[];
    preferences: string[];
    commitments: string[];
    openQuestions: string[];
    relationshipChanges: string[];
    sceneFacts: string[];
  };
  createdBy: string;
  status: 'candidate' | 'committed' | 'superseded' | 'rejected';
}
```

压缩遵守以下规则：

- 原始 Ledger 始终是恢复与审计的事实来源；删除原始记录属于单独的数据保留/隐私策略，不能伪装成摘要；
- 摘要只声明其覆盖的连续历史范围，绝不能包含该范围之后才出现的事实；
- 用户尚未被回复覆盖的消息、未解决承诺和当前 Turn 的直接输入不得被压缩丢失；
- Agent 可以提出摘要候选，但只有 `ConversationRuntime` 校验覆盖范围、源摘要哈希和 revision 后才能提交；
- Ledger 在生成摘要期间继续增长是允许的；候选仍可提交到原覆盖范围，但不能自动扩张覆盖边界；
- 替换重叠摘要必须使用 revision/CAS 校验并保留被替代版本，避免并发压缩互相覆盖；
- 摘要内容采用结构化字段，避免一段自然语言同时混淆事实、推断、承诺和未决问题。

`ContextCompiler` 按预算优先保留：

1. 应用协议与安全边界；
2. 当前 Persona；
3. 当前 Turn 和未覆盖的用户消息；
4. 近期完整消息；
5. 已提交的规范摘要；
6. 经选择的长期记忆与 Scene Projection；
7. 当前 Agent 的任务指令。

预算不足时先缩减低相关性的长期记忆和场景投影，再缩短近期历史窗口；不能通过丢弃
待回复消息、角色强设定或应用协议来满足预算。基础上下文可以按
`personaRevision + summaryRevision + sceneRevision` 缓存，发送时再追加新的输入增量，
从而兼顾一致性和低延迟。

## 规范上下文注入

应用向 Agent 传递版本化的结构化 Envelope，不把 Persona、摘要、场景事实和用户原文简单拼成一条 prompt：

```ts
interface AgentContextEnvelope {
  schemaVersion: string;
  conversationId: string;
  turnId: string;
  taskId: string;
  revisions: {
    context: number;
    persona: number;
    summary: number;
    scene: number;
  };
  applicationPolicy: ApplicationPolicyProjection;
  persona: PersonaProjection;
  longTermMemory: MemoryProjection[];
  conversationSummary?: ConversationSummaryRecord;
  recentMessages: ConversationMessage[];
  pendingUserMessages: ConversationMessage[];
  scene: SceneProjection;
  task: AgentTaskInstruction;
  manifest: {
    injectionHash: string;
    budget: ContextBudgetDiagnostics;
  };
}
```

`AgentContextEnvelope` 保留为后续通用 ContextCompiler 和多能力 Agent 的参考目标，不是首版
Char Provider 的直接输入契约。首版使用 `CharReplyTask.context: CharContextEnvelope` 跑通
流程；该角色专用 Envelope 只封装当前实际需要的 Persona、消息、焦点消息与 revision。后续
若引入 summary、scene、memory 或统一上下文编译，再参考本节重构其内部结构。新增信息不再
平铺到 `CharReplyTask` 外层。

这里的“规范”包含三个层次：

- Envelope schema 规定字段、revision、来源和可信级别；
- `ContextCompiler` 按 Agent 职责和权限生成最小必要投影；
- 各 Provider Adapter 只负责把相同语义映射到其支持的 system/developer/user 角色或协议字段。

用户消息始终保留为不可信的 `user` 内容。用户文本或旧摘要中出现的“修改系统设定”等文字，
不能在压缩或 Adapter 映射时晋升为应用规则或 Persona。未来实际采用通用
`AgentContextEnvelope` 的 Agent 结果才要求关联 `injectionHash`；首版 Char 结果只回传
task/attempt/generation、`baseContextRevision` 与 `personaRevision`。不同 Agent 可以获得
不同的最小投影，但核心 Persona 与应用协议必须来自同一 revision，不能依赖各 Agent 私有的
隐藏会话维持角色设定。

## 用户输入与自动合并

所有原始用户输入和 Task Manager 事件先形成不可变 `InteractionMessage`，再由
`RouteCoordinator` 处理。原文拥有独立 `messageId`；Router 写入单独的 RouteRecord，Char
Agent 生成的新消息通过 `references` 引用原始消息并附加派生信息，不覆盖原文。

桌面 UI 提供 `Auto / Char / Session 1/2/3...` 目标选择：显式 Char 或 session 走直连，
只有 Auto 调用 Router Agent。路由到角色后才投影为 ConversationRuntime 的用户 Turn；
路由到 session 后生成 `TaskCommand`，不会把外部命令伪装成角色对话消息。详细结构与 session
列表来源见 [Task Manager 与会话路由设计](task-manager-routing.md)。

前台输入始终立即接受。自动合并只改变任务边界，不改变原始消息：

```text
message-18 ┐
message-19 ├─ Turn-7 covers [18, 19]
message-20 ┘
```

允许的合并条件必须可配置并可观察，例如：

- 同一 conversation；
- 均为尚未分派的连续用户文本；
- 位于短防抖窗口内；
- 中间没有必须独立处理的命令、场景事务或显式发送边界；
- 合并后的大小不超过 Agent endpoint 能力和上下文预算。

Turn 保存 `coveredMessageIds`，而不是生成一条替代用户消息。若任务已经分派，新输入默认进入后续 Turn；是否取消并重启旧任务由调度策略决定，不能由 UI 或 Agent 自行猜测。

## Turn 与 Agent Task

一个 Turn 表示应用希望完成的一次语义工作，一个 Turn 可以派生一个或多个 Agent Task：

```text
Turn
  id
  origin: user | scene | system | proactive
  coveredMessageIds[]
  baseContextRevision
  personaRevision
  priorityClass
  deadline / expiresAt
  state

AgentTask
  id
  turnId
  capability: char-reply
  contextRevision
  personaRevision
  attempt
  idempotencyKey
  state
```

所有 Agent Task 必须携带相同含义的：

- `turnId`；
- `baseContextRevision`；
- `personaRevision`；
- `coveredMessageIds`；
- deadline、取消信号和幂等键。

Char Agent 返回的结果必须回传这些关联信息。基于旧 Persona、错误 Turn、已取消 generation
或超过 deadline 的结果不能进入呈现队列。任务运行期间 Ledger 因后续用户输入产生新
revision，不会单独使旧任务失效：只要任务仍对应原 Turn、Persona 未改变、未取消且未超时，
结果可以继续基于派发时冻结的 `baseContextRevision` 提交。

多 Agent 需要区分两个互不排斥的并发维度：

```text
Turn 级并发
  ├─ Turn-7 -> Char Worker A
  ├─ Turn-8 -> Char Worker B
  └─ Turn-9 -> Char Worker C

单 Turn 内任务图
  └─ Turn-7
      ├─ Char Agent（同步主干）
      └─ LocalPerformancePlanner（本地限时增强）
```

快速连续输入首先依赖 Turn 级并发：每条未被合并的输入都可以在自己的 Context
revision 上立即分派，不必等待前一个 Char Agent 完成。本阶段不引入专家 Agent 或同一
Turn 多候选；单 Turn 的用户可见文本只由一个 Char Agent 生成。

同一 conversation 的多个 Turn 可以并行计算，但正式提交默认遵守用户输入顺序。较晚 Turn
先完成时可暂存，不能越过前置 Turn 写 Ledger 或播放。新输入默认不会自动取消或 rebase
正在运行的旧 Turn；只有明确取消、显式 supersede、Persona 更新或 deadline 到期才使结果
失效。因此“并行计算”不等于“乱序写入 Ledger 或乱序播放”。

调度器至少需要处理：

- 用户任务优先于随机主动聊天；
- 截止时间与超时；重试和 endpoint 退避属于后续策略；
- 每个 Agent 的并发上限；
- 全局和单 conversation 的 backpressure；
- 为未来相同 Turn 重试预留稳定关联字段，但首版不执行重试；
- 候选结果晚到、乱序和重复；
- Agent 断开后的失败收敛；重新分派属于后续策略；
- 长任务不得永久饿死后续高优先级输入。

默认采用“每个 Turn 一个 Char reply task、多 Turn 并行”的调度。相同 Turn 的重复调用仅用于
未来失败重试或 endpoint 迁移；首版不进行重复调用，不默认并行生成多个候选，也不引入
Arbiter。提交后的摘要/记忆维护留作后续独立阶段，本轮不实现专家 Agent。

## 同步、限时增强与异步任务

任务是否阻塞用户可见响应必须显式声明：

| 类别 | 示例 | 提交约束 |
| --- | --- | --- |
| `response-critical` | 回复主干、必要的协议/安全校验 | 完成或走回退后，才允许提交相应文本 segment |
| `presentation-deadline` | 本地表情、已有动作选择、语气和分句对齐 | 不占外部 Agent；只在 segment 播放冻结点前接收 |
| `post-commit` | 摘要、长期记忆候选、索引、统计 | 不阻塞显示或播放，处理完成后产生新的 Context revision |

Agent 可以流式返回增量结果：

```ts
type AgentResultEvent =
  | { type: 'segment.proposed'; segmentId: string; textDelta: string }
  | { type: 'segment.sealed'; segmentId: string; text: string }
  | { type: 'task.completed'; taskId: string }
  | { type: 'context.patch-proposed'; taskId: string; patch: ContextPatch };

type LocalPerformanceResultEvent =
  | { type: 'segment.annotation'; segmentId: string; emotion?: EmotionHint; actions?: ActionHint[] };
```

`segmentId` 是回复文本、TTS、聊天气泡、表情和动作合并的稳定关联键。主干 Agent
sealed 一个 segment 后即可进入校验和 TTS 准备，不必等待整段回复或全部增强任务；能否正式
提交与播放仍由响应队列顺序决定。增强结果只能附着到仍未冻结的 segment，迟到结果丢弃或仅
记入诊断，不能回改已经播放的表现。

摘要和记忆任务在收到已提交回复后异步运行，通过 `context.patch-proposed` 提交候选更新。
`ConversationRuntime` 校验其来源范围和 base revision 后原子提交，并产生新的 Context
revision；它们不能修改已经提交或正在播放的回复。下一次对话读取最新已提交 revision，
无需等待所有后台维护任务清空。

## 托管 Char Agent 与独立 Task Manager

DesktopChar 的多 Turn Char 执行面固定采用 managed 模式：一个由应用持有的 Codex App
Server 为多个逻辑 Char worker 建立 ephemeral thread。它不注册用户已经打开的 CLI，
也不依赖这些 CLI 的私有历史。`AgentConnectionManager` 管理的是应用内逻辑容量和请求
关联，不再承担外部进程注册、租约或 callback 数据面。

跨项目会话监控是独立业务域。Task Manager 可以作为非 Agent 的常驻服务，通过 Session
 Monitor 轮询原始会话状态，并向 DesktopChar 发送带稳定 `sessionId` 的有界事实事件。DesktopChar
内部使用 Router Agent 在角色与具体 session 之间做无副作用的目标判断，并调用同一
Char Agent Pool 生成普通角色回复或角色化任务通知。Task
Manager 只接受已解析完成的 `sessionId + text` 命令，不能自行理解“之前那个项目”等含糊
目标。完整的用户可见时间线、二次确认和独立 Agent 配置见
[Task Manager 与会话路由设计](task-manager-routing.md)。

### 当前 Char 契约

当前代码已直接收窄为 `CharAgentEndpoint/CharReplyTask/CharReplyResult`，不是在无角色
Reply 之后增加后处理。同步 lane 只保留单角色 `char-reply`：

- 一个 Turn 默认只创建一个 Char reply task；
- 多个 Turn 可以分派给同一角色的不同 Char worker 并行生成；
- Char Agent 从任务开始就接收完整 Persona 与对话快照，只返回文本 segment，不返回可直接
  执行的表情、动作或音频；
- 首版超时、断开或明确失败后不迁移 endpoint、不重试，由应用在原 ResponseSlot sealed
  预设的角色化 `application-fallback` segment；
- 旧 endpoint 晚到的结果由 task attempt、generation、Persona revision 和 deadline 校验
  丢弃；当前 Ledger revision 变大本身不构成拒绝理由。

`application-fallback` 不是 Agent 输出。它保留原错误作为诊断，使用应用/Persona Profile
提供的固定短文本，并继续进入正常的 TTS、表现准备、顺序提交和播放路径。这样失败的前置
Turn 不会永久阻塞后续已准备回复；智能重试、迁移和隐藏失败的策略后续再设计。

表情/动作由 [本地表现模型接入设计](performance-model-integration.md) 的
`LocalPerformancePlanner` 完成。它使用独立本地推理 endpoint 和资源预算，不注册为
Agent，不读取完整 ConversationLedger，也不参与 ResponseCommitter。

## 响应队列与顺序提交

`ResponseQueueRuntime` 是每个 conversation 的响应顺序、候选生命周期和提交资格的唯一
所有者。准备队列和播放队列必须分离：前者允许推测并发，后者是单消费者顺序队列。它们
都与 Agent 连接队列不同：

```text
ResponseQueueRuntime
  Agent 结果 -> 校验 -> sealed text
                         |          |
                         v          v
                  TTS Prepare   Local Performance Prepare
                         \          /
                          ResponseAssembler
                                 |
                         顺序提交/播放屏障
                                 |
                                 v
                  Avatar PerformanceRuntime（单消费者）
```

每个未合并 Turn 创建一个稳定的响应槽位：

```ts
interface ResponseSlot {
  responseId: string;
  conversationId: string;
  turnId: string;
  turnSequence: number;
  baseContextRevision: number;
  assemblyRevision: number;
  reply: 'pending' | 'running' | 'sealed' | 'failed' | 'cancelled';
  commit: 'waiting' | 'blocked' | 'committed' | 'failed' | 'cancelled';
  presentation: 'waiting' | 'queued' | 'presenting' | 'completed' | 'failed' | 'cancelled';
  segments: ResponseSegmentDraft[];
  expiresAt?: string;
  supersededBy?: string;
}

interface ResponseSegmentDraft {
  segmentId: string;
  segmentRevision: number;
  text: string;
  speech: 'none' | 'queued' | 'running' | 'ready' | 'failed' | 'cancelled';
  performance: 'none' | 'queued' | 'running' | 'ready' | 'fallback' | 'cancelled';
}
```

reply、speech、performance、commit 和 presentation 是正交状态，不合并成一个包含所有组合
的大枚举。这样后续 Turn 可以处于“文本已 sealed、TTS/表情均 ready、提交仍 blocked”，
不会丢失真实并发状态。

队列规则：

- Agent 可并行处理多个 Turn，结果按 `responseId + turnId + turnSequence` 回到对应槽位；
- 每个文本 segment 一旦 sealed，立即并行进入 TTS 和 LocalPerformancePlanner 准备队列，
  不等待前置 Turn 回复或播放完成；
- 较晚 Turn 先得到文本时令 `commit = blocked`，但其受预算约束的准备任务仍可继续；它不能
  越过有效的前置槽位写 Ledger 或播放；
- 队首获得合格的 sealed segment 后立即顺序提交；播放还必须等待自身准备任务达到
  ready/fallback 终态和前一 Presentation 完成；
- 前置槽位只有进入 `committed`、`superseded`、`expired` 或 `cancelled` 终态，后续槽位才能推进；
- 队首超时不能无限造成队头阻塞：用户 Turn 应产生可见失败/降级结果，主动 Turn 可以直接过期；
- 过时丢弃只清理 Agent 候选、TTS 预生成物和表现增强，绝不删除原始用户消息；
- 后续 Turn 默认独立并行；只有用户或上层策略明确 `supersede` 时才取消前一 Turn，不能
  仅凭返回先后或 revision 增长猜测；
- 已提交回复不因更晚回复到达而回滚；需要纠正时创建新的正式 Turn 和响应记录。

文本是响应关键路径的最高优先级任务。调度器必须为 Char reply 能力保留并发额度；本地表现
模型使用独立任务池，但当它与 TTS
共享 GPU 时仍由应用级资源预算器协调。准备优先级依次为：当前播放缺失资源、队首响应、
队首后续 segment、下一 Turn、更远推测任务。响应被 supersede、取消
或过期时立即取消对应 TTS/表现任务；预生成必须有并发、音频缓存时长和显存上限。

## 响应组装、依赖与冻结点

表情和动作不应在未知最终回复文本时独立猜测。默认任务依赖为：

```text
reply segment sealed
        |
        +--> TTS prepare
        |
        +--> LocalPerformancePlanner
                  |
                  v
          ResponseAssembler
                  |
          timeline binding
                  |
          PerformanceRuntime
```

Char Agent 不负责表情/动作。`LocalPerformancePlanner` 在 `segment.sealed`
后获得真实 segment 文本、Persona performance projection、Scene Projection 和
Avatar capability projection，再进行段内编排。它只接收表现所需的最小投影，不复制
完整会话。

增强结果通过 `responseId + segmentId + segmentRevision` 写入
`ResponseAssembler`。动作和表情先使用语义锚点，例如句首、Unicode 文本范围、短语后、
句末或某个 cue ID；TTS 返回时长、文本 cue 或音频进度后，再由 timeline binder 映射为
实际播放时点。当前已实现的 v2 路径会把语音段拆成最多 6 个自然分句并发分析：
有 `durationMs` 时按文本进度比例绑定，没有总时长时按确定性语速估算。精确 `atMs`
始终优先，后续可由 TTS 原生 timing 或 ForcedAligner 覆盖。详见
[段内表情时序调研与阶段性实现](expression-timing.md)。

每个 segment 具有逐级冻结点：

1. `text-sealed`：文本、语言、voice/rate 等影响合成的字段冻结；修改必须产生新 revision
   并取消旧 TTS；
2. `speech-prepared`：音频可用，但尚未播放；仍可加入表情和安全可调度动作；
3. `presentation-frozen`：进入播放前的短 lookahead 窗口，当前 cue 集冻结；
4. `presenting`：只接受位于当前播放位置加安全提前量之后的 cue；
5. `completed`：所有迟到增强只记诊断，不再作用于角色。

动态插入不能直接修改播放器或 Live2D。`ResponseAssembler` 生成带
`baseAssemblyRevision` 的 `performance.patch-requested`，由 `PerformanceRuntime`
检查 generation、segment 状态、动作资源冲突、冷却时间和 lookahead 后接受或拒绝。
因此表情可以较晚附加到尚未播放的句段，动作也能编排到未来时点，但不会突然改写已经发生的
表演。

## 实时表情与离散动作快速路径

外部生成式 Agent 的 3–5 秒级延迟不能进入首段表现关键路径。Live2D 的动作来自角色资产已有
动作库，因此这里不做姿态或动作序列生成，而是对有限动作集合进行语义检索与策略选择：

```text
sealed text segment
      |
      +---------------------> TTS
      |
      +-> Local Affect Analyzer
      |      └─ affect vector
      |
      +-> Local Catalog Selector
             └─ ranked expression/action candidates
                        |
                        v
                  BehaviorPolicy
          capability / conflict / cooldown
                        |
                        v
             performance.patch-requested
```

实时路径分为三层：

1. **零等待回退**：根据 Persona 默认表情、上一段平滑状态、标点、emoji、角色
   ExpressionCatalog 和高置信关键词，立即得到合法目录候选；
2. **本地小模型**：`segment.sealed` 后与 TTS 同时运行，尽早覆盖回退结果；允许首包播放后再
   平滑加入表情，并把动作安排到仍满足提前量的后续时点；
3. **本地延迟完善**：只把较晚返回的本地表现结果附加到后续尚未冻结的 segment；
   迟到时不影响当前句，Char Agent 不参与该表现选择路径。

本地分析器不是另一个 Runtime，而是可预热、可替换的纯推理服务。目标验收预算设为：

- 模型在应用启动或角色载入时完成预热，不能在首次说话时下载或初始化；
- 目标设备为 RTX 3070；单个短 segment 从请求到完整结构化结果目标 `p95 <= 1s`，
  硬超时为 `2s`，超时后保留零等待回退；
- 分析和 TTS 并行，禁止先等分类再请求语音；
- 模型仅供本地使用，不以安装包体积、跨设备分发或纯 CPU 性能作为首要选型约束；
- 必须与实际 Qwen3-TTS 和 Live2D 同时运行压测，记录首 token、完整 JSON、显存峰值、
  TTS 首包和渲染帧时间，不能用模型单独 benchmark 代替；
- 模型、推理线程数、超时和是否启用均进入可热重载配置。

在该预算下，优先使用小型指令模型一次性完成情绪分析和动作库选择，而不是固定标签分类器。
指令模型每次接收当前角色实际可用的 `ActionDescriptor[]`，因此更容易适配不同 Live2D
资产，无需每新增一个动作就重新训练分类头：

```text
sealed segment
+ previous presentation state
+ Persona performance projection
+ current Scene/Avatar state
+ current ExpressionDescriptor[]
+ current asset ActionDescriptor[]
                    |
                    v
          LocalPerformancePlanner
                    |
            short validated JSON
```

每个资产动作应携带：

```ts
interface ActionDescriptor {
  actionId: string;
  displayName: string;
  semanticTags: string[];
  prototypeTexts: string[];
  compatibleEmotions?: string[];
  speechCompatibility: 'allowed' | 'mouth-only' | 'not-while-speaking';
  expectedDurationMs: number;
  minimumLeadMs: number;
  cooldownMs: number;
  interruptible: boolean;
  parameterClaims?: string[];
  conflictsWith?: string[];
  weight?: number;
}
```

`ActionDescriptor` 是给语义选择器看的资产能力投影；Live2D 的 `motionGroup/index`、文件路径和
SDK 对象保留在 Renderer 的 `MotionBinding` 中，不能暴露给模型或写进通用 Agent 协议。
角色载入后由 Renderer 报告可用 binding 和实测/声明时长，Avatar Runtime 将它与
ActionDescriptor 合成为本次推理的安全目录。`speechCompatibility`、`parameterClaims`
和 `interruptible` 用于过滤会压住嘴型、清除注视或无法安全中断的原生 motion。

Mao 当前六个 `TapBody` Motion 已完成人工视觉审阅，但尚未进入正式 ActionCatalog、
MotionBinding 和真实完成时点链路；具体资源语义和接入审计见
[角色级动作目录与 Mao 资产审阅](action-catalog.md)。

旧角色 v1 输出 schema 只允许引用输入目录中的 emotion/action ID；当前动态角色 v2
引用角色作用域内的 expression/action ID，并附带 catalog revision。动态表情目录和混合
Resolver 设计见 [角色动态表情目录与选择设计](expression-catalog.md)。

```ts
interface LocalPerformanceSuggestion {
  responseId: string;
  segmentId: string;
  segmentRevision: number;
  emotion: {
    emotion: string;
    intensity: number;
    confidence: number;
  };
  actions: Array<{
    actionId: string;
    anchor: 'segment-start' | 'after-clause' | 'segment-end';
    clauseIndex?: number;
    confidence: number;
  }>;
}
```

模型不输出绝对 `atMs`，也不决定一定播放。`BehaviorPolicy` 再结合 Avatar capability、
动作占用、冷却、Persona 风格、segment 剩余时间和随机抑制选择零个或一个动作。
“无动作”必须是正常且常见结果，避免每句话机械重复点头。

模型落地建议：

- 首选验证 [Qwen3.5-2B](https://huggingface.co/Qwen/Qwen3.5-2B) 的 non-thinking
  模式；限制输入上下文、`max_new_tokens <= 256` 和低温度，重点测试动态目录理解与
  中文隐含语气。当前 Transformers Provider 是 prompt-only JSON，必须保留 Adapter
  本地严格校验；Provider 支持时再启用 JSON Schema 约束生成；
- 若与 Qwen3-TTS 同驻 RTX 3070 时显存或尾延迟超标，降级测试 Qwen3.5-0.8B；
  旧一代纯文本 [Qwen3-1.7B](https://huggingface.co/Qwen/Qwen3-1.7B) 可作为兼容对照；
- [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
  支持 CUDA、GGUF 量化和 schema-constrained JSON，适合作为首个独立本地推理进程；
  schema 中把 emotion/action 写成当前资产枚举，先从生成层杜绝不存在的 motion ID；
- 若指令模型仍不能稳定达到并发预算，再退回
  [paraphrase-multilingual-MiniLM-L12-v2](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2)
  的原型句相似度检索，或基于 [CPED](https://github.com/scutcyr/CPED)
  微调专用分类器；这是延迟降级路径，不是当前首选；
- 本地运行不等于忽略模型使用约束，但许可证和包体积不再影响 Runtime 接口设计；
  模型路径、启动命令和推理 endpoint 作为本机配置管理。

语义动作与节奏动作分开处理：

- 本地文本模型选择 greet、nod、shake、tap 等具有明确语义的已有 motion；
- PCM 能量、onset、语速和停顿只驱动轻量点头、身体 sway、眨眼或强调 beat，不承担语义选择；
- TTS 若将来能提供 pitch、energy、duration 或字词时间戳，应直接用于 timeline binder；
  当前文本锚点是无时间戳回退，不是新的音频事实来源。

这种拆分与共语手势研究的结论一致：Gesticulator 同时使用文本语义和音频特征，
[FastTalker](https://arxiv.org/abs/2409.16404) 进一步复用 TTS 的 pitch、onset、energy
和 duration 以提高同步性。不过这些系统生成的是连续 3D 动作；例如
[PantoMatrix/EMAGE](https://github.com/PantoMatrix/PantoMatrix) 输出 SMPL-X/FLAME 参数，
不适合直接替代 DesktopChar 的 Live2D 动作库选择器，只可作为未来节奏编排研究参考。

## Persona 与多 Agent 一致性

角色强设定属于 Character/Profile 资产和应用管理的动态记忆，不属于任意 Agent 的私有 system prompt。Persona 至少包含：

- 固定身份、世界观和关系边界；
- 语言、措辞与行为风格；
- 禁止偏离的安全和角色约束；
- 情绪、动作与语音表现提示；
- `personaRevision` 与内容摘要/hash。

每个并行 Char worker 得到同一 revision 的完整核心 Persona，不得各自保存无法回收的角色
真相。Router 只得到完成目标判断所需的用户可见路由上下文，不生成用户可见内容。Persona
更新后，旧 revision 的未提交 Char 结果必须重新生成或丢弃。

如果多个 Char worker 为不同 Turn 并行生成，系统必须遵守：

```text
many readers / many workers / one committed reply
```

任何 Agent 都不能因为最先返回就直接调用播放器或修改正式历史。即使保留现有 `desktop_char_perform` 工具，对多 Agent 的生产接入也要在其前面增加 Turn/revision/ownership 校验。

## 主动聊天

随机聊天、Scene 事件和应用定时行为统一生成 `origin=proactive|scene` 的 Turn，不直接写 assistant 消息，也不直接提交 PerformancePlan。

主动触发至少受以下门控：

- 没有尚未覆盖的用户消息；
- 当前没有更高优先级 Turn 等待提交；
- 满足用户配置的冷却时间、勿扰时间和场景规则；
- 使用创建时的 Context revision，并设置较短 `expiresAt`；
- 用户新输入到达后可以取消、降级或使未播放结果过期。

这使随机聊天不再依赖 Codex 或某个常驻 Agent 主动调用，但也不会因为应用内部定时器而抢占用户对话。

## 唯一呈现队列

应用管理的不能只是音频 queue，而应是完整 `PerformanceUnit`：

```text
assistant text
+ chat bubble policy
+ speech segments
+ emotion / action cues
+ reply correlation
+ priority / expiry / interruption policy
```

只有 `ResponseCommitter` 接受的结果可以转换为 PerformanceUnit，并进入 Avatar/Presentation Runtime。TTS 可以并行准备多个 segment，但真实播放、聊天气泡、口型、动作和完成事实必须服从同一个呈现顺序。

呈现策略完全由应用、本地表现模型和 Runtime 决定：

- 用户回复默认高于主动聊天和环境闲聊；
- 同一已提交回复内部按 segment sequence 呈现；
- 主动聊天在用户输入到达时允许立即或句末中断；
- 普通用户回复默认不互相强行打断；
- 手动中断取消当前 TTS、音频流、播放器和尚未开始的同组 segment；
- 过期、被 supersede 或 Context revision 不再有效的结果不得开始播放；
- 队列达到上限时优先丢弃可过期主动内容，不能丢失用户消息事实。

Player 只报告 `buffering/started/progress/stalled/recovered/completed/failed` 等真实事实，不能自行取下一条或决定优先级。

## 已识别的设计风险与约束

| 风险 | 必须采用的约束 |
| --- | --- |
| “完整上下文”等同于无限 prompt | Ledger 与 ContextCompiler 分离，使用有 revision 的摘要和预算 |
| 自动合并改变用户原话 | 原始消息不可变，合并只产生 `coveredMessageIds` |
| 并行 Agent 覆盖正式历史 | 所有结果经过单一 ResponseCommitter |
| Agent 私有记忆导致人格漂移 | Persona、摘要和长期记忆由应用版本化持有 |
| 多 Char worker 同时发送语音 | Char Agent 只返回文本 segment，应用持有唯一 PerformanceQueue |
| 主动聊天抢占用户输入 | 主动 Turn 低优先级、带 TTL，并受 pending-user/cooldown 门控 |
| 只序列化音频导致动作和气泡错位 | 队列单位是完整 PerformanceUnit |
| 旧任务晚到污染新对话 | 校验 Turn、Context、Persona revision 和 generation |
| 重试造成重复回复 | request/task/turn 使用稳定幂等键 |
| 向所有 Agent 泄露全部上下文 | ContextCompiler 按角色、能力和权限最小化投影 |
| Turn 并行过多反而拖慢关键回复 | Char lane 设置并发预算、deadline、队首优先和 endpoint backpressure |
| 慢速前置 Turn 永久阻塞后续响应 | ResponseQueue 设置 deadline；用户 Turn 显式降级，主动 Turn 可过期 |
| 后续回复提前播放导致上下文错序 | 允许提前校验/TTS，但只有队首可正式提交和播放 |
| 迟到表情或动作改写已发生表现 | segment revision、冻结点、lookahead 与 PerformanceRuntime 校验 |
| 预生成 TTS 抢占当前响应资源 | 队首优先，并限制推测合成的并发、缓存和可取消生命周期 |

## 实现前结论与验收项

已经确定采用单角色、多 Turn Char worker 并发、managed Char 执行面、应用单写提交和本地
表现规划。最小内存调度框架已验证双 worker、乱序结果提前准备和顺序播放；新用户输入默认
不会让已运行 Turn 失效。配置已经迁移为 `agentProviders + agentRoles`，并发使用
`agentRoles.char.maxConcurrency`，不接受旧 `conversation.maxAssistants` 兼容别名。
Router 与 Task Manager 实现前已经定案：

1. Auto 模式下，单个候选同时超过可配置的最低置信度与领先幅度时直接提交；只有多个合理
   候选接近时二次确认。Router 调用或结构校验失败直接向前台报错，不回退 Char、不产生
   session 副作用；`no-match` 提示用户改写输入或显式选择目标。
2. 首版使用嵌套 `CharReplyTask.context: CharContextEnvelope`；通用
   `AgentContextEnvelope` 仅保留为后续重构参考。新增 summary、scene 等信息不再平铺到
   `CharReplyTask`。
3. Char Agent MCP 固定为初期测试 Adapter，不进入生产 Provider 路线；首版契约完成后不再
   扩展能力，只保留必要的兼容修复。

首版 Char 失败策略已经确定为“不重试，由应用提交预设角色通知并放行后续 Turn”。Task
Manager 持久化也不阻塞跑通：首版仅保证单进程生命周期内的 cursor/ack、submission
generation 和命令幂等，跨重启恢复与持久化格式标记为后续待设计。

2026-07-30 的 Codex CLI 实机测试确认，Session Monitor 的 `submitted: true` 仅表示控制台
输入事件已写入：一次测试中正文进入了输入编辑框，但目标没有进入 `active`，Enter 也没有
实际触发提交。Task Manager 因此必须先观察 `active`，再观察屏幕变化和稳定恢复到
`waiting_input`，否则在激活超时后报告失败，不能发布虚假的完成通知或自动重试。
Session Monitor 的 Enter 提交可靠性仍需在 WorkAssistant 侧修复；active 状态下 `/input`
究竟表示运行中补充还是下一轮排队，也继续作为目标 CLI 的实机验收项。

在这些策略确定前，不实现让多个 Agent 直接调用播放器或并发写正式 ConversationLedger 的路径。
