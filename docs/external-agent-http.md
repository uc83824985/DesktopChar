# 外部 Agent 本地 HTTP 接入指南

> 本文保留兼容 HTTP case。新 Agent 优先使用 DesktopChar 自身的角色接入 MCP Server；其动态启停、默认 `http://127.0.0.1:17374/mcp` endpoint、四个工具和重连语义见 [MCP 服务生命周期与角色接入接口](mcp-services.md)。HTTP 与角色接入 MCP 共用同一计划校验和 Runtime 命令入口。

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
requestedMode = managed
activeMode    = mcp
provider      = desktop-char-local-tts
transport     = http://127.0.0.1:8766/mcp
```

`activeMode=mcp` 是正确结果：`managed` 表示 DesktopChar 负责 Provider 进程生命周期，实际控制面仍只使用正式 MCP 协议。若要对照四音高版本，在应用 JSON 的 `ttsMcp.profiles.local.synthesis.voice` 选择 `jrpg-blip-varied` 后启动即可。

```powershell
$env:DESKTOP_CHAR_TTS_VOICE = "jrpg-blip-varied"
npm run desktop
```

若要验证 `external` 所有权，可以分两个终端启动：

```powershell
# 终端 1：固定监听 8766
npm run tts:local-mcp

# 终端 2：使用 lifecycle.type=external、connection.url 指向 8766 的配置
$env:DESKTOP_CHAR_CONFIG_PATH = "C:\DesktopCharConfigs\external-local-tts.json"
npm run desktop
```

`external` 停用或退出时只关闭 DesktopChar 的 MCP session，不会停止终端 1。普通首次接入使用单条 `npm run desktop` 即可。

#### `external_tts_mcp`：接入真实 Qwen3-TTS

需要接入真实 Qwen3-TTS 时的最短可复现流程：

1. 启动 Qwen3-TTS 语音合成 MCP：

```powershell
cd G:\Qwen3-TTS-GGUF
.\Start-DesktopChar-TTS-MCP.ps1
```

2. 将 DesktopChar 配置为 `external` 后启动：

```powershell
cd G:\DesktopChar
$env:DESKTOP_CHAR_CONFIG_PATH = "C:\DesktopCharConfigs\qwen-external.json"
npm run desktop
```

3. 验证 DesktopChar 已实际接入语音合成 MCP：

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

若使用 `external`，先启动语音服务再启动桌面角色；若使用 `managed`，DesktopChar 会按 JSON 中的绝对脚本路径启动并拥有该 Provider。

Qwen3-TTS 语音合成 MCP 示例：

```powershell
cd G:\Qwen3-TTS-GGUF
python 63-Background-TTS-MCP-Server.py --model-dir model-base --voice output/design/my_voice.json --host 127.0.0.1 --port 8766 --path /mcp
```

DesktopChar 示例：

```powershell
cd G:\DesktopChar
$env:DESKTOP_CHAR_CONFIG_PATH = "C:\DesktopCharConfigs\qwen-external.json"
npm run desktop
```

对应配置的关键部分为：

```json
{
  "ttsMcp": {
    "autoStart": true,
    "activeProfile": "qwen-external",
    "profiles": {
      "qwen-external": {
        "lifecycle": { "type": "external" },
        "connection": {
          "transport": "streamable-http",
          "url": "http://127.0.0.1:8766/mcp",
          "timeoutMs": 30000
        },
        "contract": { "profile": "desktop-char.tts.streaming", "version": 1 },
        "synthesis": { "format": "pcm_s16le" }
      }
    }
  }
}
```

地址、超时、voice 与启动程序均通过设备 JSON 修改。工具名和关键参数名由 TTS Profile 固定，不能在配置中重映射。

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

支持 `complete`、`stream` 和 `karaoke`。语音合成正常时聊天气泡只在 `playback.started` 后显示，完成后等待 `dismissDelayMs` 再隐藏。精确分块/高亮可由 Agent 提供与 `displayText` 完全拼接一致的 `cues`；若语音合成 MCP（TTS）返回匹配的 `text_cues`，Runtime 优先采用实际语音对齐信息。当前 HTTP 仍提交完整计划，`stream` 是播放时钟驱动的渐进显示，不是网络 token 流。语音合成不可用时 Runtime 改为 `presenting`，强制完整文本并按字符数估算 2–12 秒显示时间，不产生语音、口型、流式追加或 KTV 高亮。完整契约见 [角色聊天气泡](speech-bubble.md)。

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:17373/v1/interrupt
```

中断会进入 Runtime 的 generation 事务，取消未完成 TTS、停止播放并忽略旧 generation 的迟到事件。

## 状态反馈

当前最小版使用 `GET /v1/state` 轮询完整 `AvatarSnapshot`：

- `ready`：模型及 Runtime 是否可接收计划；
- `snapshot.state`：`idle`、`thinking`、`speaking`、`presenting`（无音频纯文本回退）；
- `snapshot.planId / segmentId / sequence`：当前表演位置；
- `snapshot.playback.status / positionMs`：真实播放生命周期；
- `snapshot.speechBubble.phase / positionMs`：由 Runtime 持有的聊天气泡播放与延迟关闭状态；
- `snapshot.lastError`：最近的可恢复或不可恢复错误。

完成条件是同一 `planId` 执行后 Runtime 回到 `idle`，不是 HTTP 202、Agent 文本完成或 TTS source ready。若后续 Agent 需要低延迟主动反馈，可在不改变领域契约的前提下增加 SSE；SSE 只投影 snapshot/生命周期，不持有状态。

## 中文与 UTF-8

HTTP JSON 和 Streamable HTTP MCP 链路均按 UTF-8 传输；官方 MCP Client 的集成测试会提交 `你好` 并断言 Runtime 收到的字符串逐字一致。Windows PowerShell 5.1 不应使用 `@'...中文...'@ | node --input-type=module -` 一类管道把临时源码送入原生进程：其 native stdin 转码可能在请求发出前把非 ASCII 字符替换为 `?`，表现为中文乱码而 `MCP` 等英文正常。前台脚本应保存为 UTF-8 `.mjs` 后执行，使用 PowerShell 7，或在临时命令中使用 `\uXXXX`/code point 转义。不要在接收端猜测并反转已经丢失的字符。

## 语音合成 MCP 接入上下文

默认配置以 `managed` 生命周期启动根目录 [`local-tts-mcp`](../local-tts-mcp/README.md) 真实参考进程，再由 Electron main 通过官方 SDK 建立 Streamable HTTP MCP session。Renderer 只装配 `McpTtsAdapter`；Local TTS 与 Qwen3-TTS 共享固定工具、流响应、取消和播放器契约。改为 `external` 后 DesktopChar 只连接配置的 endpoint，远端不可用时不会静默回退，也不会停止外部服务。完整规范见 [TTS MCP 接入指南](tts-mcp-integration.md)。

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

- 三个强制工具、input/output Schema 与 `tts_status` 健康检查；
- 固定语义的 `tts_open_stream` 合成调用；
- `tts_cancel_synthesis` generation 中断；
- stream/artifact、request id、codec、采样率、声道校验；
- URI、base64 audio、viseme、amplitude 和可选 `text_cues` 结构归一化；
- 超时、AbortSignal、MCP tool error 和迟到结果处理。

managed Local TTS 的桌面应用配置为：

```json
{
  "ttsMcp": {
    "activeProfile": "local",
    "profiles": {
      "local": {
        "lifecycle": {
          "type": "managed",
          "start": {
            "executable": "node",
            "args": ["local-tts-mcp/server.mjs"],
            "cwd": ".",
            "env": {
              "DESKTOP_CHAR_TTS_LOCAL_MCP_PORT": "8766",
              "DESKTOP_CHAR_TTS_LOCAL_RATE": "1",
              "DESKTOP_CHAR_TTS_LOCAL_CHAR_MS": "232"
            }
          }
        }
        "connection": { "url": "http://127.0.0.1:8766/mcp" },
        "contract": { "profile": "desktop-char.tts.streaming", "version": 1 },
        "synthesis": { "format": "pcm_s16le", "voice": "jrpg-blip" }
      }
    }
  },
  "character": {
    "profile": "models/Mao/DesktopChar.character.json"
  }
}
```

Local Provider 的 `DESKTOP_CHAR_TTS_LOCAL_RATE` 范围是 `0.5..2.0`；角色口型增益位于资产 Profile 的 `lipSyncProfile.gain`，不改变 PCM 播放音量。external 配置为：

```json
{
  "ttsMcp": {
    "activeProfile": "external-local",
    "profiles": {
      "external-local": {
        "lifecycle": { "type": "external" },
        "connection": {
          "transport": "streamable-http",
          "url": "http://127.0.0.1:8766/mcp",
          "timeoutMs": 30000
        },
        "contract": { "profile": "desktop-char.tts.streaming", "version": 1 },
        "synthesis": { "format": "pcm_s16le" }
      }
    }
  }
}
```

旧生命周期环境变量在迁移期仍作为 JSON 缺省字段的 fallback；独立启动 `local-tts-mcp` 时使用的进程变量不受桌面应用配置迁移影响。完整边界见 [配置所有权与 JSON 重构方案](configuration.md)。

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

### 统一桌面启动入口

桌面端统一使用 `npm run desktop`。通过 `DESKTOP_CHAR_CONFIG_PATH` 选择 managed 或 external 设备配置；不再提供 `desktop:mcp` 包装脚本。新 Provider 不得通过改名映射绕过 Profile，只能实现固定工具和 Schema。

## 自动化验收

```powershell
npm run test:desktop
npm run check
```

HTTP 测试会在临时 loopback 端口真实发送请求，覆盖健康状态、完整计划、interrupt、busy、Content-Type、非法计划和端口约束。接入新 Agent 时还应运行本节的 PowerShell 命令，并观察角色从 `thinking -> speaking -> idle`，确认嘴型来自播放电平而非请求计时器。
