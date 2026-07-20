# 外部 Agent 本地 HTTP 接入指南

## 定位与边界

该模式是独立的应用装配 case，不是新的 Avatar Runtime。外部 Agent 决定回复文本以及期望的表情/动作；DesktopChar 负责 TTS、真实播放时钟、口型、表情、动作和中断一致性。Agent 不得直接写 Live2D 参数，也不得把 TTS 完成当作角色表演完成。

```text
External Agent
  -> loopback HTTP control plane
  -> Electron main (network owner)
  -> allowlisted IPC
  -> PerformancePlan / AvatarEvent
  -> AvatarRuntime
  -> TTS Adapter -> Audio Runtime -> Live2D Renderer
  -> runtime snapshot feedback
```

当前 HTTP case 随桌面应用启动，默认只绑定 `127.0.0.1:17373`。可通过 `DESKTOP_CHAR_AGENT_PORT` 修改端口；设置为 `0` 仅用于自动化测试选择临时端口。服务不开放局域网监听，不处理 LLM、历史、工具调用或 ASR。

## 启动与健康检查

```powershell
npm run desktop
Invoke-RestMethod http://127.0.0.1:17373/v1/health
Invoke-RestMethod http://127.0.0.1:17373/v1/capabilities
Invoke-RestMethod http://127.0.0.1:17373/v1/state
```

`health.status=ready` 表示 renderer 已加载模型并发布 Runtime snapshot；`starting` 时提交表演会返回 HTTP 503。`capabilities.avatar` 在 renderer ready 后包含实际模型支持的 emotion、action 和参数能力。

## 提交最小表演

第一阶段只接受完整计划，不接受 token 流或 `segment.appended`。请求必须使用 `application/json`，body 上限为 256 KiB：

```powershell
$body = @{
  id = "agent-reply-001"
  segments = @(
    @{
      id = "agent-reply-001-0"
      sequence = 0
      displayText = "很高兴见到你"
      speechText = "很高兴见到你"
      emotion = @{ emotion = "happy"; intensity = 0.7 }
      actions = @(@{ id = "reply-nod"; action = "nod"; atMs = 200 })
    }
  )
} | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:17373/v1/performances `
  -ContentType application/json `
  -Body $body
```

成功投递返回 HTTP 202 和 `planId`。角色非 `idle` 时返回 HTTP 409；Agent 应等待 `/v1/state` 回到 `idle`，或明确发起中断，不能盲目重试覆盖当前表演。

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:17373/v1/interrupt
```

中断会进入 Runtime 的 generation 事务，取消未完成 TTS、停止播放并忽略旧 generation 的迟到事件。

## 状态反馈

当前最小版使用 `GET /v1/state` 轮询完整 `AvatarSnapshot`：

- `ready`：模型及 Runtime 是否可接收计划；
- `snapshot.state`：`idle`、`thinking`、`speaking`；
- `snapshot.planId / segmentId / sequence`：当前表演位置；
- `snapshot.playback.status / positionMs`：真实播放生命周期；
- `snapshot.lastError`：最近的可恢复或不可恢复错误。

完成条件是同一 `planId` 执行后 Runtime 回到 `idle`，不是 HTTP 202、Agent 文本完成或 TTS source ready。若后续 Agent 需要低延迟主动反馈，可在不改变领域契约的前提下增加 SSE；SSE 只投影 snapshot/生命周期，不持有状态。

## TTS MCP 接入上下文

当前应用 case 默认装配 `MockTtsAdapter`，用于在没有本机 TTS 服务时验证 Agent -> Runtime -> 表现链路。现有真实接入边界已经准备为：

```text
concrete MCP session transport
  -> McpClientPort
  -> McpTtsAdapter
  -> TtsRuntimeEffectHandler
  -> tts.segment-ready / tts.segment-failed
  -> AvatarRuntime
```

`McpTtsAdapter` 已覆盖：

- `tools/list` 健康检查；
- `tts_open_stream` 合成调用和参数名配置；
- `tts_cancel_synthesis` generation 中断；
- stream/artifact、request id、codec、采样率、声道校验；
- URI、base64 audio、viseme 和 amplitude 结构归一化；
- 超时、AbortSignal、MCP tool error 和迟到结果处理。

环境配置由 `loadTtsConfig()` 定义：

```text
DESKTOP_CHAR_TTS_MODE=mcp
DESKTOP_CHAR_TTS_MCP_TOOL=tts_open_stream
DESKTOP_CHAR_TTS_MCP_CANCEL_TOOL=tts_cancel_synthesis
DESKTOP_CHAR_TTS_REQUEST_ID_ARGUMENT=request_id
DESKTOP_CHAR_TTS_TEXT_ARGUMENT=text
DESKTOP_CHAR_TTS_TIMEOUT_MS=30000
DESKTOP_CHAR_TTS_FORMAT=pcm_s16le
DESKTOP_CHAR_TTS_VOICE=<optional>
```

仍需由具体部署提供一个真实 `McpClientPort`，负责 MCP initialize/session、`tools/list` 与 `tools/call` 的 transport 生命周期。它可以是 stdio 或 Streamable HTTP，但不能让 renderer 直接持有子进程或远程认证信息：推荐在 Electron main/独立 sidecar 中建立会话，再通过白名单 IPC 暴露 `listTools/callTool`。完成该注入前，即使设置 `DESKTOP_CHAR_TTS_MODE=mcp`，当前 composition root 仍不会隐式切换离开 Mock；这是为了避免“配置显示 MCP、实际却静默降级”的错误验收。

真实 MCP 返回流描述至少应包含：

```json
{
  "request_id": "generation-segment-id",
  "delivery": "stream",
  "uri": "http://127.0.0.1:PORT/audio/request-id",
  "mime_type": "audio/pcm",
  "codec": "pcm_s16le",
  "sample_rate_hz": 24000,
  "channels": 1
}
```

MCP 工具应尽快返回流 URI；HTTP 音频端点随后增量产生字节。若工具等待整句合成完成后才返回，Adapter 能正确播放但无法满足低首包延迟目标。更完整的结构与诊断方法见 [TTS Adapter](tts-adapter.md)。

## 自动化验收

```powershell
npm run test:desktop
npm run check
```

HTTP 测试会在临时 loopback 端口真实发送请求，覆盖健康状态、完整计划、interrupt、busy、Content-Type、非法计划和端口约束。接入新 Agent 时还应运行本节的 PowerShell 命令，并观察角色从 `thinking -> speaking -> idle`，确认嘴型来自播放电平而非请求计时器。
