# 外部 Agent 本地 HTTP 接入指南

> 本文保留兼容 HTTP case。新 Agent 优先使用 DesktopChar 自身的角色 MCP Server；其动态启停、默认 `http://127.0.0.1:17374/mcp` endpoint、四个工具和重连语义见 [MCP 服务生命周期与角色控制接口](mcp-services.md)。HTTP 与角色 MCP 共用同一计划校验和 Runtime 命令入口。

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

### 选择 TTS 后端

外部 Agent 接入时可以把 TTS 后端记为以下两个应用装配选项：

- `local_tts_mcp`：仓库自带的参考 MCP，适合首次接入、自动化测试和排除真实模型性能因素；
- `external_tts_mcp`：外部 Qwen3-TTS 等真实 MCP，适合完成协议联调后的实际语音测试。

这两个名称用于接入配置和文档沟通，不是 `/v1/performances` 的请求字段。Agent 提交的 `PerformancePlan` 不选择 Provider；具体 TTS 后端在 DesktopChar 启动时确定。

#### `local_tts_mcp`：推荐的首次接入方式

仓库默认已经选择 `local_tts_mcp`，只需启动桌面应用：

```powershell
cd G:\DesktopChar
npm run desktop
```

Electron main 会在随机 loopback 端口自动启动 [`local-tts-mcp`](../local-tts-mcp/README.md)，再通过正式 MCP Client、`McpTtsAdapter` 和 HTTP PCM 数据面消费它；这不是 Renderer 内的 Mock 或播放器旁路。它支持：

- 默认固定 560 Hz 的 `jrpg-blip`；
- 可选、可重复的四音高 `jrpg-blip-varied`；
- Unicode 字素级提示音和标点静音停顿；
- sample-aligned `duration_ms` 与 `text_cues`；
- 流式 PCM、取消、真实播放电平、角色级口型增益和聊天气泡同步。

启动后验证：

```powershell
(Invoke-RestMethod http://127.0.0.1:17373/v1/health).status
(Invoke-RestMethod http://127.0.0.1:17373/v1/capabilities).tts
```

期望 `health.status=ready`，并看到：

```text
requestedMode = local
activeMode    = mcp
provider      = desktop-char-local-tts
transport     = http://127.0.0.1:<随机端口>/mcp
```

`activeMode=mcp` 是正确结果：`local` 表示 DesktopChar 负责服务生命周期，实际控制面仍使用正式 MCP 协议。若要对照四音高版本，可在启动前选择 voice：

```powershell
$env:DESKTOP_CHAR_TTS_VOICE = "jrpg-blip-varied"
npm run desktop
```

若要让参考服务也模拟“外部进程独立部署”，可以分两个终端启动：

```powershell
# 终端 1：固定监听 8766
npm run tts:local-mcp

# 终端 2：把它当作外部 MCP 注入
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/desktop-mcp-tts.ps1 `
  -McpUrl "http://127.0.0.1:8766/mcp" `
  -Voice "jrpg-blip-varied"
```

该方式适合验证外部进程、固定端口和 `desktop:mcp` 包装层；普通首次接入使用单条 `npm run desktop` 即可。

#### `external_tts_mcp`：接入真实 Qwen3-TTS

需要接入真实 Qwen3-TTS 时的最短可复现流程：

1. 启动 Qwen3-TTS MCP：

```powershell
cd G:\Qwen3-TTS-GGUF
.\Start-DesktopChar-TTS-MCP.ps1
```

2. 启动 DesktopChar MCP 包装脚本：

```powershell
cd G:\DesktopChar
npm run desktop:mcp
```

3. 验证 DesktopChar 已实际接入 MCP TTS：

```powershell
(Invoke-RestMethod http://127.0.0.1:17373/v1/health).status
(Invoke-RestMethod http://127.0.0.1:17373/v1/capabilities).tts
```

期望结果：

- `health.status = ready`
- `tts.activeMode = mcp`
- `tts.transport = http://127.0.0.1:8766/mcp`

4. 发送一条最小测试语音：

```powershell
$body = @{
  id = "agent-smoke-001"
  segments = @(
    @{
      id = "agent-smoke-001-0"
      sequence = 0
      displayText = "联调测试"
      speechText = "这是一次桌面角色与MCP语音联调测试。"
      emotion = @{ emotion = "happy"; intensity = 0.6 }
      actions = @(@{ id = "agent-smoke-001-nod"; action = "nod"; atMs = 180 })
    }
  )
} | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:17373/v1/performances `
  -ContentType application/json `
  -Body $body
```

5. 轮询状态直到回到 `idle`：

```powershell
1..12 | ForEach-Object {
  Invoke-RestMethod http://127.0.0.1:17373/v1/state | ConvertTo-Json -Compress -Depth 8
  Start-Sleep -Milliseconds 700
}
```

期望状态链路：

- `idle -> thinking/loading`
- `thinking/buffering`
- `speaking/playing`
- `idle`

当前已验证的热启动表现：

- 这套接入链路可以稳定进入 `speaking`
- 热启动 `submit -> speaking` 约 `1.0s`
- 若首轮明显更慢，通常是模型、音色、MCP session 或播放器冷启动，不应立即判定接入失败

如果要让 DesktopChar 通过外部 MCP TTS 服务合成语音，先启动 TTS MCP 服务，再用包装脚本启动桌面角色。使用默认 `local_tts_mcp` 时不需要执行这一步。

Qwen3-TTS MCP 示例：

```powershell
cd G:\Qwen3-TTS-GGUF
python 63-Background-TTS-MCP-Server.py --model-dir model-base --voice output/design/my_voice.json --host 127.0.0.1 --port 8766 --path /mcp
```

DesktopChar 示例：

```powershell
cd G:\DesktopChar
npm run desktop:mcp
```

`desktop:mcp` 等价于设置以下环境变量后执行 `npm run desktop`：

```text
DESKTOP_CHAR_TTS_MODE=mcp
DESKTOP_CHAR_TTS_MCP_URL=http://127.0.0.1:8766/mcp
DESKTOP_CHAR_TTS_MCP_TOOL=tts_open_stream
DESKTOP_CHAR_TTS_MCP_CANCEL_TOOL=tts_cancel_synthesis
DESKTOP_CHAR_TTS_REQUEST_ID_ARGUMENT=request_id
DESKTOP_CHAR_TTS_TEXT_ARGUMENT=text
DESKTOP_CHAR_TTS_FORMAT=pcm_s16le
DESKTOP_CHAR_TTS_TIMEOUT_MS=30000
```

可覆盖参数：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/desktop-mcp-tts.ps1 `
  -McpUrl "http://127.0.0.1:8766/mcp" `
  -Tool "tts_open_stream" `
  -CancelTool "tts_cancel_synthesis" `
  -Format "pcm_s16le" `
  -TimeoutMs 60000
```

启动后确认 DesktopChar 实际使用 MCP：

```powershell
(Invoke-RestMethod http://127.0.0.1:17373/v1/capabilities).tts
```

期望 `activeMode` 为 `mcp`，`transport` 为 MCP URL。

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

每个 segment 可选声明 `bubble`，控制 `displayText` 的应用层聊天气泡：

```json
{
  "bubble": {
    "mode": "stream",
    "charactersPerSecond": 10,
    "dismissDelayMs": 800
  }
}
```

支持 `complete`、`stream` 和 `karaoke`。聊天气泡只在 `playback.started` 后显示，完成后等待 `dismissDelayMs` 再隐藏。精确分块/高亮可由 Agent 提供与 `displayText` 完全拼接一致的 `cues`；若 TTS MCP 返回匹配的 `text_cues`，Runtime 优先采用实际语音对齐信息。当前 HTTP 仍提交完整计划，`stream` 是播放时钟驱动的渐进显示，不是网络 token 流。完整契约见 [角色聊天气泡](speech-bubble.md)。

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
- `snapshot.speechBubble.phase / positionMs`：由 Runtime 持有的聊天气泡播放与延迟关闭状态；
- `snapshot.lastError`：最近的可恢复或不可恢复错误。

完成条件是同一 `planId` 执行后 Runtime 回到 `idle`，不是 HTTP 202、Agent 文本完成或 TTS source ready。若后续 Agent 需要低延迟主动反馈，可在不改变领域契约的前提下增加 SSE；SSE 只投影 snapshot/生命周期，不持有状态。

## TTS MCP 接入上下文

当前应用 case 的 `local_tts_mcp` 选项默认自动启动根目录 [`local-tts-mcp`](../local-tts-mcp/README.md) 真实参考服务，并由 Electron main 通过官方 SDK 建立 Streamable HTTP MCP session；Renderer 只装配 `McpTtsAdapter`，本地与远端共享工具参数、流响应、取消和播放器契约。设置 `DESKTOP_CHAR_TTS_MODE=mcp` 后切换为 `external_tts_mcp`：只会把 session URL 改为外部服务并停止自动启动本地服务。远端不可用时不会静默回退到本地。

真实接入边界为：

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
- URI、base64 audio、viseme、amplitude 和可选 `text_cues` 结构归一化；
- 超时、AbortSignal、MCP tool error 和迟到结果处理。

`local_tts_mcp` 的主要环境配置为：

```text
DESKTOP_CHAR_TTS_MODE=local
DESKTOP_CHAR_TTS_LOCAL_RATE=1
DESKTOP_CHAR_TTS_LOCAL_CHAR_MS=232
DESKTOP_CHAR_TTS_VOICE=<jrpg-blip 或 jrpg-blip-varied>
DESKTOP_CHAR_LIP_SYNC_GAIN=2.5
```

`DESKTOP_CHAR_TTS_LOCAL_RATE` 范围是 `0.5..2.0`；`DESKTOP_CHAR_LIP_SYNC_GAIN` 只改变 Runtime 的嘴型映射，不改变 PCM 播放音量。`external_tts_mcp` 的环境配置为：

```text
DESKTOP_CHAR_TTS_MODE=mcp
DESKTOP_CHAR_TTS_MCP_URL=http://127.0.0.1:8766/mcp
DESKTOP_CHAR_TTS_MCP_TOOL=tts_open_stream
DESKTOP_CHAR_TTS_MCP_CANCEL_TOOL=tts_cancel_synthesis
DESKTOP_CHAR_TTS_REQUEST_ID_ARGUMENT=request_id
DESKTOP_CHAR_TTS_TEXT_ARGUMENT=text
DESKTOP_CHAR_TTS_TIMEOUT_MS=30000
DESKTOP_CHAR_TTS_FORMAT=pcm_s16le
DESKTOP_CHAR_TTS_VOICE=<optional>
```

MCP session 生命周期由 Electron main 管理，renderer 不直接持有子进程或远程认证信息。若 MCP 服务不可用，renderer 不会阻塞窗口显示；TTS 健康检查会标记不可用，实际提交表演时会进入可恢复失败。

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

### `desktop:mcp` 的定位

`npm run desktop:mcp` 是 `external_tts_mcp` 或“独立进程运行的参考 MCP”的启动入口。新 Agent 首次验证 HTTP 控制面时优先使用 `local_tts_mcp` 对应的 `npm run desktop`；只有明确需要注入外部服务时才切换到该脚本。它封装了 `DESKTOP_CHAR_TTS_MODE=mcp` 及默认 MCP 参数，并允许覆盖 URL、工具名、voice 或超时。

不建议新接入方手动逐个设置环境变量，除非：

- 需要连接非默认 MCP 地址
- 需要更换工具名或参数名
- 需要拉长超时窗口做冷启动或调试

## 自动化验收

```powershell
npm run test:desktop
npm run check
```

HTTP 测试会在临时 loopback 端口真实发送请求，覆盖健康状态、完整计划、interrupt、busy、Content-Type、非法计划和端口约束。接入新 Agent 时还应运行本节的 PowerShell 命令，并观察角色从 `thinking -> speaking -> idle`，确认嘴型来自播放电平而非请求计时器。
