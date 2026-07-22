# DesktopChar TTS MCP 接入指南

本文面向实现或接入 TTS MCP Provider 的开发者。目标是让 Local TTS、Qwen3-TTS 和其他语音服务通过完全相同的 Client、Adapter、播放器与 Runtime 路径工作，不在 DesktopChar 内增加 Provider 特判。

当前固定契约为：

```text
Profile: desktop-char.tts.streaming
Version: 1
Transport: MCP Streamable HTTP
Required tools: tts_status, tts_open_stream, tts_cancel_synthesis
```

工具名、关键参数名和返回字段是 Profile 的一部分，不能在 DesktopChar 配置中重命名。

## 1. 职责边界

完整调用链为：

```text
Runtime
  -> TtsMcpAdapter
  -> DesktopChar MCP Client
  -> TTS MCP Provider
  -> HTTP audio stream
  -> Player
  -> playback clock / lip sync / chat bubble
```

各模块职责如下：

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| Runtime | 发起合成、打断、消费播放事实 | Provider 生命周期和推理实现 |
| TtsMcpAdapter | 固定语义参数、结果归一化、错误分类 | 启动脚本和 Provider 特判 |
| MCP Supervisor | 连接、Profile 校验、健康检查、重连；仅在 `managed` 下管理入口进程 | 模型、GPU、推理队列等内部状态 |
| TTS Provider | 合成、流式音频、请求取消、能力与就绪状态 | DesktopChar 的播放和角色状态 |
| Player | 消费音频流、发布播放时钟和电平 | 合成任务调度 |

Local TTS 是参考 Provider，不是 Mock Adapter。其他 Provider 应复制它的协议行为，而不是复制其音频生成算法。

## 2. 生命周期模式

`ttsMcp.lifecycle.type` 只允许 `external` 或 `managed`。

### 2.1 external

Provider 由用户、系统服务、容器或其他程序拥有。DesktopChar：

- 不执行启动程序；
- 不持有或结束 Provider 进程；
- 只连接 `connection.url`，执行 Profile 检查和健康检查；
- 连接失败时按 `reconnect` 配置重试；
- 停用时只关闭自己的 MCP session。

适合共享服务、远端服务以及需要独立维护 GPU 生命周期的服务。

### 2.2 managed

DesktopChar 拥有一个配置明确的入口子进程。启动流程为：

1. 以 `shell: false` 执行 `lifecycle.start.executable` 和 `args`。
2. 使用配置的 `cwd` 和附加环境变量启动，不解析拼接后的 shell 命令。
3. 在 `startupTimeoutMs` 内轮询 `connection.url`。
4. 完成 MCP initialize，读取 `tools/list` 并校验 Profile。
5. 调用 `tts_status`；只有 Provider 报告可接收请求后才向应用发布语音能力。
6. 运行期监控入口进程，并按 `healthIntervalMs` 调用 `tts_status`。

停止或重载时，DesktopChar 关闭 MCP session，然后直接结束自己创建的入口进程；超过 `shutdownTimeoutMs` 后执行强制结束。该路径不依赖 Provider 额外暴露生命周期工具。

入口程序必须满足以下约束：

- 保持前台运行，不得启动后台服务后立即退出；
- 入口进程退出时，对应 endpoint 必须消失；
- 如果入口程序创建了派生进程，应由入口程序保证它们随入口退出而清理；
- stdout/stderr 可用于启动失败诊断，但不能用交互式输入阻塞启动；
- `restartOnFailure=true` 时必须允许 DesktopChar 重新执行同一启动命令。

只有 `managed` 管理进程。两种模式使用完全相同的 MCP Profile、Adapter 和音频数据面。

## 3. DesktopChar 配置规则

配置位于 `desktop-char.config.json` 的 `ttsMcp` 分区。当前原生结构固定为“多 Profile + 活动选择器”：

```json
{
  "ttsMcp": {
    "autoStart": true,
    "activeProfile": "local",
    "profiles": {
      "local": {
        "lifecycle": {
          "type": "managed",
          "start": {
            "executable": "node",
            "args": ["local-tts-mcp/server.mjs"],
            "cwd": "."
          }
        },
        "connection": {
          "transport": "streamable-http",
          "url": "http://127.0.0.1:8766/mcp"
        },
        "synthesis": {
          "format": "pcm_s16le",
          "voice": "jrpg-blip",
          "rate": 1
        }
      },
      "qwen": {
        "lifecycle": {
          "type": "managed",
          "start": {
            "executable": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            "args": [
              "-NoProfile",
              "-ExecutionPolicy", "Bypass",
              "-File", "G:\\Qwen3-TTS-GGUF\\Start-DesktopChar-TTS-MCP.ps1"
            ],
            "cwd": "G:\\Qwen3-TTS-GGUF"
          }
        },
        "connection": {
          "transport": "streamable-http",
          "url": "http://127.0.0.1:8766/mcp"
        },
        "synthesis": {
          "format": "pcm_s16le",
          "rate": 1
        }
      }
    }
  }
}
```

切换时只需修改 `ttsMcp.activeProfile`，例如从 `local` 改为 `qwen`，然后在前台执行“重新加载配置”。

旧的单套 `ttsMcp.lifecycle/connection/...` 写法不再受支持。

字段语义：

| 字段 | 规则 |
| --- | --- |
| `autoStart` | 应用启动后的初始启用状态；不改变生命周期所有权 |
| `activeProfile` | 必需；必须指向 `profiles` 中的一个键 |
| `profiles` | 必需；命名配置集合，每个 profile 都使用同一套 TTS MCP 结构 |
| `lifecycle.type` | 只能是 `external` 或 `managed` |
| `lifecycle.start` | 仅 `managed` 使用；推荐绝对路径，参数必须拆成数组 |
| `startupTimeoutMs` | 等待 managed Provider endpoint 和 Profile 就绪的上限 |
| `shutdownTimeoutMs` | 等待 owned 入口进程退出的上限 |
| `healthIntervalMs` | 就绪后的 `tts_status` 检查间隔 |
| `restartOnFailure` | 仅 managed 决定异常退出后是否重新启动入口进程 |
| `connection.transport` | Profile v1 固定为 `streamable-http` |
| `connection.url` | MCP 控制面 endpoint，必须与 Provider 实际监听地址一致 |
| `connection.timeoutMs` | MCP 调用超时，不是整句音频生成时限 |
| `contract.profile` | 固定为 `desktop-char.tts.streaming` |
| `contract.version` | 当前固定为 `1` |
| `synthesis.format` | 默认请求的音频格式，必须在 Provider 能力中声明 |
| `synthesis.voice` | 可选默认音色，必须是 Provider 接受的值 |
| `synthesis.rate` | 可选默认语速，范围固定为 `0.5` 到 `2`，透传到 `tts_open_stream.rate` |
| `reconnect` | MCP 连接的指数退避上下限 |

external profile 不应包含 `lifecycle.start`：

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
        "contract": {
          "profile": "desktop-char.tts.streaming",
          "version": 1
        },
        "synthesis": { "format": "pcm_s16le" }
      }
    }
  }
}
```

配置文件支持运行时重载。TTS 正在播放时，影响服务的重载会等待 Runtime 回到空闲边界，再重建连接或 managed 进程。

## 4. 强制语义接口

Provider 必须通过 `tools/list` 发布以下三个工具，并同时提供 `inputSchema` 和 `outputSchema`。语义数据必须写入 MCP `structuredContent`；`content` 可以提供人类可读摘要，但 DesktopChar 不解析其中的自然语言结果。

### 4.1 tts_status

用途：区分“MCP 连接可用”和“TTS 当前可接受合成请求”。该调用必须快速、无副作用，不应在调用时首次加载模型。

输入：空对象。

最小输出：

```json
{
  "profile": "desktop-char.tts.streaming",
  "profile_version": 1,
  "provider": "qwen3-tts",
  "status": "ready",
  "accepting_requests": true,
  "capabilities": {
    "streaming": true,
    "cancellation": true,
    "formats": ["pcm_s16le"],
    "voices": [],
    "text_cues": false,
    "test_fixtures": []
  }
}
```

约束：

- `profile` 和 `profile_version` 必须与配置一致；
- `provider` 是稳定、非空的实现标识；
- `status` 只能是 `ready`、`degraded` 或 `unavailable`；
- 只有 `ready` 且 `accepting_requests=true` 会通过就绪检查；
- `streaming` 和 `cancellation` 在 Profile v1 中必须为 `true`；
- `formats` 至少包含一种格式；
- `voices`、`test_fixtures` 即使为空也必须返回数组；
- `text_cues` 必须明确返回布尔值；
- 可以增加 `message` 或其他诊断字段，但不得修改标准字段语义。

### 4.2 tts_open_stream

用途：创建合成任务并尽快返回可消费的音频流。工具不得等待完整语句合成结束后才返回。

请求示例：

```json
{
  "request_id": "generation-7:segment-2",
  "text": "需要朗读的文本。",
  "delivery": "stream-required",
  "format": "pcm_s16le",
  "voice": "speaker-name",
  "language": "zh-CN",
  "instruction": "自然、温和",
  "rate": 1.0
}
```

字段规则：

- `request_id`、`text` 是强制字段，并且不能为空；
- `request_id` 在当前 MCP session 的活动任务中必须唯一；
- Provider 必须接受 `stream-required` 和 `stream-preferred`；
- `format` 应与 `tts_status.capabilities.formats` 一致；
- `voice`、`language`、`instruction`、`rate` 是可选扩展参数；
- Provider 不支持某个已传入参数时，应返回明确的 MCP tool error，不得静默改变文本。

最小响应：

```json
{
  "stream": {
    "request_id": "generation-7:segment-2",
    "delivery": "stream",
    "stream_url": "http://127.0.0.1:8766/audio/opaque-token",
    "mime_type": "audio/pcm",
    "codec": "pcm_s16le",
    "sample_rate_hz": 24000,
    "channels": 1
  }
}
```

响应约束：

- 返回的 `request_id` 必须与请求一致；
- `stream_url` 应使用不可猜测 token，推荐单次消费并设置未领取过期时间；
- `codec`、`sample_rate_hz`、`channels` 必须描述真实字节流，播放器不会猜测；
- 音频 URL 必须允许 DesktopChar Renderer 来源读取，例如 `desktop-char://app` 和开发期 loopback origin；
- 播放器中断 HTTP 读取时，Provider 应尽快停止对应生成并释放资源；
- 推荐原始 PCM 以减少首包延迟和解码等待。

可选同步字段：

```json
{
  "duration_ms": 1800,
  "text_cues": [
    { "text": "需要", "at_ms": 0, "duration_ms": 420 },
    { "text": "朗读", "at_ms": 420, "duration_ms": 460 }
  ],
  "amplitude": [
    { "at_ms": 0, "value": 0.0 },
    { "at_ms": 40, "value": 0.6 }
  ],
  "visemes": [
    { "at_ms": 40, "duration_ms": 90, "viseme": "A", "weight": 0.8 }
  ]
}
```

`text_cues` 用于聊天气泡流式/KTV 对齐；`amplitude` 或 `visemes` 可用于更精确的口型。缺少这些字段时，DesktopChar 使用播放电平和已知时长的回退算法。

### 4.3 tts_cancel_synthesis

用途：按 `request_id` 取消已经排队、正在推理或正在流式输出的任务。

输入：

```json
{ "request_id": "generation-7:segment-2" }
```

输出：

```json
{
  "request_id": "generation-7:segment-2",
  "cancelled": true
}
```

约束：

- 返回的 `request_id` 必须与请求一致；
- `cancelled=true` 表示本次找到并终止了活动任务；
- 任务不存在或已经结束时返回 `cancelled=false`；
- 重复取消必须安全，不得取消相同 ID 之外的任务；
- 取消必须同时终止生成、结束音频响应并释放队列/GPU任务等 Provider 内部资源。

## 5. 控制面与音频数据面

MCP endpoint 是控制面，负责状态、创建流和取消请求。实际音频通过 `stream_url` 独立传输。这样 `tts_open_stream` 可以在首个可播放数据准备好后立即返回，而生成器继续分块输出后续音频。

Provider 应避免：

- 将完整音频编码为 MCP 文本 JSON 后才返回；
- 等待整句生成完成再创建 URL；
- 用自然语言日志代替 `structuredContent`；
- 让多个请求复用同一个可公开猜测的音频地址；
- MCP session 断开后继续保留无人消费的生成任务。

建议的 Provider 内部映射为：

```text
(session_id, request_id)
  -> synthesis job
  -> cancellation token
  -> one-time audio token
  -> HTTP streaming response
```

该映射属于 Provider 内部实现，不暴露给 DesktopChar 的进程管理层。

## 6. Local TTS 参考实现

参考代码位于：

- `local-tts-mcp/server.mjs`：前台进程入口与信号处理；
- `local-tts-mcp/service.mjs`：MCP、任务映射、音频 endpoint 和三个工具；
- `local-tts-mcp/service.test.mjs`：官方 MCP Client、真实 HTTP 流、取消和能力测试；
- `tts-mcp-profile/contract.mjs`：DesktopChar 侧 Profile 校验器。

Local TTS 默认由 DesktopChar 以 `managed` 启动，也可以执行 `npm run tts:local-mcp` 后改用 `external` 验证所有权边界。

## 7. 新 Provider 接入步骤

以 Qwen3-TTS 为例：

1. 在 Provider 自身仓库实现三个固定工具和双向 JSON Schema。
2. 确保 `tts_open_stream` 返回真实的增量音频 URL，而不是整句文件生成结果。
3. 用 `(session_id, request_id)` 维护任务与取消映射。
4. 实现无副作用的 `tts_status`，准确声明格式、音色和同步能力。
5. 将启动入口调整为持续前台运行，并保证直接结束入口进程后 endpoint 稳定消失。
6. 先以 `external` 启动服务并通过连接测试，排除进程管理因素。
7. 再配置为 `managed`，验证启动、热重载、异常重启和停用。
8. 不修改 `TtsMcpAdapter`，不新增 Provider 名称判断或工具映射。

PowerShell managed 启动示例：

```json
{
  "lifecycle": {
    "type": "managed",
    "start": {
      "executable": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "args": [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "G:\\Qwen3-TTS\\Start-DesktopChar-TTS-MCP.ps1"
      ],
      "cwd": "G:\\Qwen3-TTS"
    },
    "startupTimeoutMs": 180000,
    "shutdownTimeoutMs": 15000,
    "healthIntervalMs": 10000,
    "restartOnFailure": true
  },
  "connection": {
    "transport": "streamable-http",
    "url": "http://127.0.0.1:8766/mcp",
    "timeoutMs": 30000
  }
}
```

## 8. 验收清单

Provider 接入完成必须满足：

1. `tools/list` 包含三个固定工具，每个工具均发布 object 类型的 `inputSchema` 和 `outputSchema`。
2. `tts_status` 返回匹配的 Profile、版本、Provider 标识和真实就绪状态。
3. `tts_open_stream` 在完整句子生成完成前返回，并可立即读取首批音频数据。
4. 流描述与真实 codec、采样率、声道一致，请求 ID 不发生错配。
5. `tts_cancel_synthesis` 能终止排队、生成和活动 HTTP 流，并可安全重复调用。
6. 聊天气泡从 `playback.started` 开始，随播放时钟推进，播放结束后按策略关闭。
7. 无同步元数据时播放电平仍可驱动口型；提供同步元数据时字段能被正确归一化。
8. `external` 停用后 Provider 进程和 endpoint 继续存在。
9. `managed` 停用后 owned 入口进程退出且 endpoint 消失。
10. Provider 不可用时，Runtime 仍能使用无声聊天气泡回退，不伪造语音口型。

仓库侧回归命令：

```powershell
npm run test:local-mcp
npm run test:desktop
npm test
npm run typecheck
```

前台可通过右键菜单启用“语音合成”，再执行“测试 MCP 连接”；连接结果会通过角色聊天气泡显示。
