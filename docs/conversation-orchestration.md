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

单 Agent 只作为 endpoint 不足或调度故障时的兼容降级路径，不作为高频桌面交互的目标形态。上下文、任务和提交协议从一开始按多 Agent 建模，目标架构验收必须覆盖至少两个 reply Agent 对不同 Turn 的并发任务、乱序返回、取消和唯一提交。当前多 Agent 主要用于降低连续输入的等待时间，并把提交后的上下文维护移出响应关键路径；表情和动作不再分派给外部 Agent，而由本地表现模型处理。它不能改变“规范上下文由应用持有、用户可见回复单写提交、实际呈现由应用仲裁”的边界。

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
├─ AgentTaskRuntime
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
`AgentTaskRuntime` 是否最终并入 `ConversationRuntime`，取决于实现阶段是否需要独立恢复、
并发限制和任务快照，但它不能拥有第二份对话记录。

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

这里的“规范”包含三个层次：

- Envelope schema 规定字段、revision、来源和可信级别；
- `ContextCompiler` 按 Agent 职责和权限生成最小必要投影；
- 各 Provider Adapter 只负责把相同语义映射到其支持的 system/developer/user 角色或协议字段。

用户消息始终保留为不可信的 `user` 内容。用户文本或旧摘要中出现的“修改系统设定”等文字，
不能在压缩或 Adapter 映射时晋升为应用规则或 Persona。Agent 结果必须回传
`turnId`、`taskId`、相关 revision 和 `injectionHash`，由 `ResponseCommitter`
判断它是否仍可接受。不同 Agent 可以获得不同的最小投影，但核心 Persona 与应用协议必须来自
同一 revision，不能依赖各 Agent 私有的隐藏会话维持角色设定。

## 用户输入与自动合并

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
  agentId
  contextRevision
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

Agent 返回的候选结果必须回传这些关联信息。基于旧 Persona、错误 Turn、已取消 generation 或不可接受 Context revision 的结果不能进入呈现队列。

多 Agent 需要区分两个互不排斥的并发维度：

```text
Turn 级并发
  ├─ Turn-7 -> 一个可独立完成回复的 Agent
  ├─ Turn-8 -> 另一个可独立完成回复的 Agent
  └─ Turn-9 -> 第三个可独立完成回复的 Agent

单 Turn 内任务图
  └─ Turn-7
      ├─ reply Agent（同步主干）
      ├─ LocalPerformancePlanner（本地限时增强）
      └─ context-maintenance Agent（提交后异步）
```

快速连续输入首先依赖 Turn 级并发：每条未被合并的输入都可以在自己的 Context
revision 上立即分派，不必等待前一个 Agent 完成。单 Turn 内再按复杂度选择完整 Agent、
专用 Agent 或本地规则，不能因为采用功能分工而重新把整个 conversation 串行化。

同一 conversation 的多个 Turn 可以并行计算，但正式提交默认遵守用户输入顺序。较晚 Turn
先完成时可暂存候选，不能越过仍可能影响其语义的前置 Turn。若后续输入明显补充或纠正前一条，
调度器可以合并、supersede 或在前置结果提交后 rebase；若它们语义独立，则保留独立响应。
因此“并行计算”不等于“乱序写入 Ledger 或乱序播放”。

调度器至少需要处理：

- 用户任务优先于随机主动聊天；
- 截止时间、超时、重试与 endpoint 退避；
- 每个 Agent 的并发上限；
- 全局和单 conversation 的 backpressure；
- 相同 Turn 的幂等重试；
- 候选结果晚到、乱序和重复；
- Agent 断开后的重新分派；
- 长任务不得永久饿死后续高优先级输入。

默认采用“每个 Turn 一个 reply task、多 Turn 并行”的调度。相同 Turn 的重复调用仅用于
失败重试或 endpoint 迁移，不默认并行生成多个候选，也不引入 Arbiter。提交后的
context-maintenance task 可以批处理多个已提交 Turn，但任何结果都不能绕过单一提交入口。

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

## 外部 Agent 自注册

DesktopChar 不应在核心配置中硬编码 Provider、模型名称、SDK 或密钥。外部 Agent
自行管理这些实现细节，并向应用注册一个可访问的交互 endpoint 和能力描述：

```ts
interface AgentRegistration {
  agentId: string;
  instanceId: string;
  endpoint: string;
  protocolVersion: string;
  capabilities: Array<'reply' | 'context-maintenance'>;
  resultModes: Array<'complete' | 'streaming'>;
  maxConcurrency: number;
  latencyClass?: 'realtime' | 'interactive' | 'background';
  costClass?: 'local' | 'low' | 'standard' | 'high';
  leaseExpiresAt: string;
}
```

Provider 与具体模型可以完全隐藏；`latencyClass`、`costClass` 也只是可选的调度提示。
应用只依赖协议版本、能力、并发额度、健康状态和实际观测到的延迟/成功率进行路由。
注册可以借用角色接入 MCP 作为控制面，但任务请求和流式结果继续走 Agent 提供的独立
HTTP/流式 endpoint，不让 MCP 承担消息数据面或 Agent 生命周期管理。

注册必须使用租约、实例 ID、健康检查和会话认证。Agent 断开或租约到期后，
`AgentTaskRuntime` 将未完成任务重新路由；恢复连接的旧实例不能继续提交已失效任务。

### 当前多 Agent 范围

同步 lane 只保留 `reply`：

- 一个 Turn 默认只创建一个 reply task；
- 多个 Turn 可以分派给不同 reply Agent 并行生成；
- reply Agent 只返回文本 segment，不返回可直接执行的表情、动作或音频；
- 同一 Turn 只有在超时、断开或明确失败后才迁移 endpoint，幂等键保持不变；
- 旧 endpoint 晚到的结果由 task attempt 和 lease 校验丢弃。

异步 lane 只保留 `context-maintenance`：

- 输入仅来自已经提交的 Ledger 记录，不读取未采用 reply 候选；
- 可以提出 SummaryRecord、长期记忆和关系事实的 Context patch；
- 可以批量覆盖多个已提交 Turn，并使用低优先级、独立并发额度；
- patch 经过 base revision、覆盖范围、来源哈希和 CAS 校验后才提交；
- context patch 到达会生成新 revision，但不自动取消已经运行的 reply task；只有 Persona、
  安全协议或当前 Turn 直接依赖事实发生不兼容变化时才要求 rebase。

表情/动作由 [本地表现模型接入设计](performance-model-integration.md) 的
`LocalPerformancePlanner` 完成。它使用独立本地推理 endpoint 和资源预算，不注册为
Agent，不读取完整 ConversationLedger，也不参与 ResponseCommitter。

## 响应队列与顺序提交

`ResponseQueueRuntime` 是每个 conversation 的响应顺序、候选生命周期和提交资格的唯一
所有者。它与 `AvatarRuntime` 中的呈现队列不同：

```text
ResponseQueueRuntime
  Agent 结果 -> 校验 -> 暂存/过时判定 -> 顺序提交
                                      |
                                      v
                              PerformanceUnit
                                      |
                                      v
Avatar PerformanceRuntime
  TTS/气泡/动作准备 -> 顺序播放 -> 完成或中断
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
  state:
    | 'waiting-text'
    | 'text-ready'
    | 'commit-blocked'
    | 'committed'
    | 'presenting'
    | 'completed'
    | 'superseded'
    | 'expired'
    | 'cancelled';
  segments: ResponseSegmentDraft[];
  expiresAt?: string;
  supersededBy?: string;
}
```

队列规则：

- Agent 可并行处理多个 Turn，结果按 `responseId + turnId + turnSequence` 回到对应槽位；
- 较晚 Turn 先得到文本时进入 `commit-blocked`，不能越过有效的前置槽位写 Ledger 或播放；
- 队首获得合格的 sealed segment 后立即提交该响应并启动 TTS/呈现关键路径；
- 前置槽位只有进入 `committed`、`superseded`、`expired` 或 `cancelled` 终态，后续槽位才能推进；
- 队首超时不能无限造成队头阻塞：用户 Turn 应产生可见失败/降级结果，主动 Turn 可以直接过期；
- 过时丢弃只清理 Agent 候选、TTS 预生成物和表现增强，绝不删除原始用户消息；
- 后续 Turn 若补充或纠正前一 Turn，可以显式 `supersede`、合并覆盖范围或在最新 Context
  revision 上重新分派，不能仅凭返回先后猜测；
- 已提交回复不因更晚回复到达而回滚；需要纠正时创建新的正式 Turn 和响应记录。

文本是响应关键路径的最高优先级任务。调度器必须为 reply 能力保留并发额度，不能让
context-maintenance 任务耗尽全部 Agent 槽位；本地表现模型也使用独立推理并发池。对于当前可提交的队首，
文本通过校验后直接启动语音合成；对于仍被前置 Turn 阻塞的后续响应，可以受预算限制地
提前合成，但只允许缓存音频，禁止提前播放。响应被 supersede、取消或过期时立即取消对应
TTS；预生成必须有并发、内存和时长上限，避免推测任务反过来拖慢队首。

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

外部 reply Agent 不负责表情/动作。`LocalPerformancePlanner` 在 `segment.sealed`
后获得真实 segment 文本、Persona performance projection、Scene Projection 和
Avatar capability projection，再进行段内编排。它只接收表现所需的最小投影，不复制
完整会话。

增强结果通过 `responseId + segmentId + segmentRevision` 写入
`ResponseAssembler`。动作和情绪先使用语义锚点，例如句首、短语后、句末或某个 cue ID；
TTS 返回时长、文本 cue 或音频进度后，再由 timeline binder 映射为实际播放时点。这样表现
Agent 不需要猜测音频时长，也不会把文字生成速度误当成播放进度。

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
      |      └─ emotion + intensity
      |
      +-> Local Action Selector
             └─ ranked action intent
                        |
                        v
                  BehaviorPolicy
          capability / conflict / cooldown
                        |
                        v
             performance.patch-requested
```

实时路径分为三层：

1. **零等待回退**：根据 Persona 默认表情、上一段平滑状态、标点、emoji 和高置信关键词，
   立即得到 neutral/thinking/happy 等基础结果；
2. **本地小模型**：`segment.sealed` 后与 TTS 同时运行，尽早覆盖回退结果；允许首包播放后再
   平滑加入表情，并把动作安排到仍满足提前量的后续时点；
3. **外部 Agent 增强**：只编排后续尚未冻结的 segment，或为长回复提出跨段动作计划；
   迟到时不影响当前句。

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
+ allowed emotions
+ current asset ActionDescriptor[]
                    |
                    v
          LocalPerformancePlanner
                    |
              constrained JSON
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

输出 schema 只允许引用输入目录中的 emotion/action ID：

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
  模式；限制输入上下文、`max_new_tokens <= 256`、低温度并使用 JSON Schema 约束，
  重点测试动态动作目录理解与中文隐含语气；
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
- TTS 若将来能提供 pitch、energy、duration 或字词时间戳，应直接用于 timeline binder。

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

每个 Agent 得到相同 revision 的核心 Persona；不同职责 Agent 可以获得不同的任务指令和最小上下文投影，但不得各自保存无法回收的角色真相。Persona 更新后，旧 revision 的未提交结果必须重新校验、重新生成或丢弃。

如果多个 Agent 并行产生用户可见候选，系统必须遵守：

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
| 多 Agent 同时发送语音 | reply Agent 只返回文本 segment，应用持有唯一 PerformanceQueue |
| 主动聊天抢占用户输入 | 主动 Turn 低优先级、带 TTL，并受 pending-user/cooldown 门控 |
| 只序列化音频导致动作和气泡错位 | 队列单位是完整 PerformanceUnit |
| 旧任务晚到污染新对话 | 校验 Turn、Context、Persona revision 和 generation |
| 重试造成重复回复 | request/task/turn 使用稳定幂等键 |
| 向所有 Agent 泄露全部上下文 | ContextCompiler 按角色、能力和权限最小化投影 |
| Turn 并行过多反而拖慢关键回复 | reply lane 设置并发预算、deadline、队首优先和 endpoint backpressure |
| 慢速前置 Turn 永久阻塞后续响应 | ResponseQueue 设置 deadline；用户 Turn 显式降级，主动 Turn 可过期 |
| 后续回复提前播放导致上下文错序 | 允许提前校验/TTS，但只有队首可正式提交和播放 |
| 迟到表情或动作改写已发生表现 | segment revision、冻结点、lookahead 与 PerformanceRuntime 校验 |
| 预生成 TTS 抢占当前响应资源 | 队首优先，并限制推测合成的并发、缓存和可取消生命周期 |

## 下一阶段仍需明确的策略

已经确定采用多 Turn reply 并发、外部 Agent 自注册、应用单写提交、本地表现规划，并将
摘要/记忆作为可回滚的异步 Context patch。实现调度器前仍需依次决定：

1. 如何判断后续输入与前置 Turn 语义独立、补充或纠正，以选择暂存、rebase 或 supersede；
2. 新用户输入到达时，正在运行的 reply task 默认继续、取消重启还是降级为过期候选；
3. Persona 合规采用结构校验、规则评分还是提交前轻量复核；
4. endpoint 自报的并发/延迟提示与应用实际观测指标如何共同进入 reply 路由；
5. RTX 3070 上 TTS、LocalPerformancePlanner 和推测 TTS 的并发、显存与 lookahead 预算；
6. 后台 Context patch 的冲突合并、人工纠正和数据保留策略。

在这些策略确定前，不实现让多个 Agent 直接调用播放器或并发写正式 ConversationLedger 的路径。
