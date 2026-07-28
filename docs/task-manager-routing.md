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
  用户可见时间线 -> Router Agent -> 二次确认
  原始事件 -> Char Agent -> TTS / 表情 / 动作 / 播放
```

- 多 Turn Reply：DesktopChar 内部使用一个 managed Codex App Server，不连接用户 CLI。
- Task Manager：可以完全不使用 LLM；只监控、保存状态、发布原始事件并执行确定命令。
- Router Agent：只理解用户输入与候选会话的相关性，输出结构化建议，不产生副作用。
- Char Agent：把原始任务结果改写成符合角色性格的通知、建议或追问，不负责路由。
- Session Monitor：是 CLI 会话事实与输入能力的基础设施，不拥有 DesktopChar 的对话语义。

因此 “DeepSeek” 只表示 Router Agent 可以使用一份独立 Provider/Profile；它不是固定模型，
也不表示 Char Agent 必须使用同一 endpoint。

## Task Manager 服务边界

Task Manager 适合作为随系统或用户会话启动的常驻脚本/服务。它读取 Session Monitor v3
marker 和 token，通过 loopback HTTP 使用：

- `GET /api/sessions`：读取会话摘要；
- `GET /api/sessions/{sessionId}`：按需读取完整可见文本；
- `POST /api/sessions/{sessionId}/input`：向确定会话 `insert` 或 `submit` 文本；
- `GET /api/monitor/events`：辅助恢复监控游标和诊断。

端口必须从 marker 的 `httpBaseUrl` 发现，token 只从 `httpTokenFile` 读取，不能写进仓库
配置或日志。`capabilities.sessionInput.enabled` 为真后才可使用 `/input`。该接口不要求
CLI 窗口位于前台，也不要求 `agentState == waiting_input`；`agentState` 基于可见终端文本
推断，只能作为启发式信号，不能当成 CLI 官方完成事件。

Task Manager 自身应提供窄领域接口，而不是把 Session Monitor 全量透传给 DesktopChar：

```text
GET  /health
GET  /sessions
GET  /events?after=<cursor>
POST /commands
POST /events/<eventId>/ack
```

事件至少携带 `eventId`、单调 cursor、`sessionId`、事件类型、观察时间、状态、
原始结果文本或其引用、来源 hash/revision。Task Manager 保存去重与 ack 状态，DesktopChar
保存收到的原始 payload 和派生呈现记录。断线重连从最后 ack cursor 恢复，不能靠“最近一条
文本”猜测是否已经通知。

命令必须已经消除歧义：

```ts
interface TaskCommand {
  commandId: string;
  sessionId: string;
  text: string;
  mode: 'insert' | 'submit';
  contextRevision: number;
}
```

Task Manager 不接受 `target: "之前那个项目"`、候选列表或自然语言路由指令。它校验
session 仍存在、命令幂等键未执行，再调用 Session Monitor。状态轮询本身永远不能触发
`/input`；只有用户已授权且 DesktopChar 已确定目标的命令可以产生副作用。

## 用户可见时间线

路由依据必须是用户实际感知的信息，而不是后台流水线的最新状态。DesktopChar 为每个通知
保留以下阶段：

```text
received -> transformed -> speech-preparing -> queued
         -> presenting -> presentation-completed
         \-> suppressed / interrupted / failed
```

只有 `presentation-completed` 才追加到 Router 的 `visibleTimeline`。如果使用无语音的完整
文本回退，则前台确认完整文本已经渲染后等价为完成。以下状态均不能改变用户语义中的“刚才”
或“继续”：

- Task Manager 已收到 A 的结果，但 DesktopChar 尚未处理；
- Char Agent 已改写，TTS/表情仍在后台准备；
- A 的通知已经排队；
- A 正在播放或文字仍在渐进呈现；
- 通知被抑制、中断，或只产生不可见诊断。

用户按下发送时冻结 `visibleContextRevision`。即使 Router 推理期间又有通知播放完成，本次
判断仍使用冻结快照，避免发送前后目标漂移。

## Router Agent 输入与决策

Router Agent 不需要完整 `SessionRoutingContext`。输入保持为用户可理解的最小场景：

- 当前用户输入；
- 最近约 8–12 条完整呈现的用户/角色时间线；
- 最近约 3–6 个候选任务的标题、简短摘要、状态和最后用户可见事件；
- 用户显式选择的会话（若有）；
- 尚待用户确认的路由建议（若有）；
- 冻结的 context revision。

候选集合采用 LRU/相关性混合维护，不能只保存“最后一个 session”。LRU 的更新时间来自
用户显式发送或通知完整呈现；后台收到事件不更新用户可见活跃顺序。

Router 输出严格结构：

```ts
interface RouteDecision {
  contextRevision: number;
  decision: 'route' | 'confirm' | 'no_match';
  targetSessionId?: string;
  candidates: Array<{
    sessionId: string;
    score: number;
    reason: string;
  }>;
}
```

- 用户显式选择 session 时，确定性规则优先，不必调用 Router。
- 单个候选显著领先且高于阈值时返回 `route`。
- 多个候选接近时返回 `confirm`，DesktopChar 列出少量候选并等待用户二次确认。
- 没有足够相关候选时返回 `no_match`，不得发送。
- Router 只能引用输入候选中的 `sessionId`，不能生成新 ID，也不能直接调用 Task Manager。
- 用户确认后要重新校验 session 状态和 context revision，再生成唯一 `TaskCommand`。

示例：

1. 用户最后一次明确发给 B；A 的完成通知刚到但仍在合成或播放，此时“继续”仍路由 B。
2. A 的通知完整播放后，用户说“继续”，用户可见的最近话题已是 A，默认候选转为 A。
3. 用户说“继续之前那个项目”，Router 必须结合可见历史和多个 LRU 候选评分；仍有两个
   接近候选时询问用户，不发送。
4. 用户在界面显式选择 B 后输入“继续”，直接使用 B；新到达的 A 后台事件不能覆盖选择。

## Char Agent 与 Router Agent 独立配置

WorkAssistant 的 `start_*_agent` 启动器已经验证了可复用模式：每个 Agent 可以独立选择
命令、模型、base URL、工作目录、初始 prompt 和隔离的运行环境；包装启动器只选择具体
entry script，不把 Provider 设置写入全局配置。DesktopChar 后续采用相同原则，但拆成
“可复用 Provider Profile + Agent 角色绑定”，避免每个角色复制整份连接信息。

下面是目标配置形态，不是当前 `desktop-char.config.json` 已支持的 schema：

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
    "reply": {
      "provider": "codex-managed",
      "maxConcurrency": 2
    },
    "char": {
      "provider": "codex-managed",
      "promptProfile": "profiles/char/default.json"
    },
    "router": {
      "provider": "router-deepseek",
      "promptProfile": "profiles/router/session-routing.json",
      "temperature": 0,
      "maxTimelineEntries": 12,
      "maxCandidates": 6
    }
  }
}
```

配置规则：

- Char 与 Router 的 Provider、模型、base URL、超时、温度和 prompt profile 均可独立；
- 独立配置不等于必须启动两个进程，同一 Provider Adapter 可以按 profile 复用连接池；
- Router 优先选择低延迟、稳定结构化输出的远程轻量模型，DeepSeek 只是首个候选；
- Char 可以使用更强模型，且只接收生成角色化表达所需的原始事件和 Persona 投影；
- role binding 不直接包含密钥；只允许 `apiKeyEnv` 或后续 `secretRef`；
- managed 子进程只获得自身所需的 child environment，可按 Provider 使用隔离的配置目录；
- 任何启动脚本、示例 JSON、审计快照和前台状态都不得输出 token 或 API key；
- Profile 热重载只影响新请求；已经冻结的路由决策和正在呈现的通知继续使用原 revision。

当前已实现的配置仍只有 `conversation.maxAssistants` 与
`conversation.reply.requestTimeoutMs`，Reply 固定为 managed Codex App Server。上述
Provider/Profile 分层应在 Router/Char 接口落地时一并加入 schema、脱敏快照与配置测试，
不能先把某个 DeepSeek endpoint 硬编码进业务逻辑。

## 处理链路

任务完成通知：

```text
Session Monitor observed change
 -> Task Manager de-duplicate and emit raw event
 -> DesktopChar store raw event
 -> Char Agent produce character notice + optional suggestion
 -> local performance planning and TTS prepare
 -> single PresentationQueue
 -> presentation-completed
 -> append visibleTimeline and update candidate LRU
```

用户回复：

```text
user input
 -> freeze visibleContextRevision
 -> explicit target rule, otherwise Router Agent
 -> route / confirm / no_match
 -> optional user confirmation
 -> validate revision and session state
 -> TaskCommand(sessionId, text, submit)
 -> Task Manager
 -> Session Monitor /input
```

Char Agent 的建议只是用户可见内容，不自动转化为 TaskCommand。Router 的高分判断也只是
提议；只有确定性目标或用户确认后，DesktopChar 才能发送。

## 实施顺序

1. 先实现 Task Manager 的 marker/token 发现、Session Monitor 轮询、去重事件日志、
   cursor/ack 和精确命令接口。
2. DesktopChar 接收并保存原始事件，完成无 Agent 的确定性通知与播放闭环。
3. 增加 `visibleTimeline`、候选 LRU、冻结 revision 和显式 session 选择。
4. 实现无副作用 Router Agent、结构校验、阈值策略与二次确认。
5. 实现 Char Agent 的角色化通知，并保持原始事件可审计、可重新处理。
6. 最后落地 Provider Profile/Agent Role 配置、密钥引用、热重载和故障回退。
