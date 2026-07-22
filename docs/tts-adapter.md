# TTS Adapter：流式优先契约

用户侧统一称为“语音合成 MCP”；`TTS`、`tts-mcp-adapter`、`tts.*` 事件和配置字段是保持兼容的技术标识。

## 结论

`tts-mcp-adapter` 采用“控制面与数据面分离”的流式优先设计：

- MCP 工具是控制面，只接收合成参数并尽快返回流描述；
- HTTP 音频流端点是数据面，播放器增量读取音频字节；本地参考服务与真实服务使用同一种数据面；
- `tts.segment-ready` 表示音频源已可打开，不表示整句已经合成完；
- 播放器报告缓冲、开始、卡顿、恢复、实时电平和完成事实；
- Avatar Runtime 仍是角色状态的唯一所有者。

这避免把整句音频以 MCP base64 结果返回后才开始播放。整段 WAV/MP3 仍作为兼容模式保留，但默认运行链路要求流式源。

## 模块边界

```text
Runtime tts.synthesize Effect
  -> TtsRuntimeEffectHandler
       -> TtsAdapter.prepare(request)
            -> McpTtsAdapter -> McpClientPort -> MCP tts_open_stream
                                  |- local-tts-mcp Streamable HTTP
                                  `- external Streamable HTTP MCP
                                            |
                                            `-> AudioStreamSource(stream_url)
  -> Runtime tts.segment-ready Event
       -> audio.play Effect
            -> HTTP/raw PCM player
                 -> PlaybackEvent -> Runtime
```

Adapter 负责请求映射、流描述校验、超时、取消、错误分类和旧格式兼容；不负责播放、分句排序、表情、动作或角色状态。`requestId` 在 Runtime generation 和 segment 范围内生成，服务端若返回其他 ID，Adapter 会拒绝该结果。

## 领域数据结构

流式源必须明确声明解码所需信息：

```ts
interface AudioStreamSource {
  delivery: 'stream';
  requestId: string;
  uri: string;
  mimeType: string;
  codec: 'pcm_s16le' | 'pcm_f32le' | 'wav' | 'mp3' | 'ogg' | 'opus';
  sampleRateHz: number;
  channels: number;
  durationMs?: number;
  visemes?: VisemeTiming[];
  amplitude?: AmplitudeSample[];
  textCues?: Array<{ text: string; atMs: number; durationMs?: number }>;
}
```

默认格式为单声道、24 kHz、little-endian signed 16-bit PCM。Qwen3-TTS 当前 Python API 的最终波形是 24 kHz `float32 numpy.ndarray`；服务层可直接输出 `pcm_f32le`，或钳制到 `[-1, 1]` 后转换为 `pcm_s16le`。后者带宽更小，也是当前默认值。

HTTP 响应块边界只是 transport 分片，不是句子、token 或音频帧边界。播放器必须保留不足一个采样帧的尾部字节并与下一块拼接，不能假设一次 `read()` 对应固定时长。

## MCP 请求与流响应

默认工具名为 `tts_open_stream`，请求示例：

```json
{
  "request_id": "g3:segment-0",
  "text": "需要合成的文本",
  "delivery": "stream-required",
  "format": "pcm_s16le",
  "language": "Chinese",
  "voice": "optional-voice",
  "instruction": "optional-style"
}
```

推荐通过 `structuredContent.stream` 返回：

```json
{
  "stream": {
    "request_id": "g3:segment-0",
    "delivery": "stream",
    "stream_url": "http://127.0.0.1:8765/audio/g3%3Asegment-0",
    "mime_type": "audio/pcm",
    "codec": "pcm_s16le",
    "sample_rate_hz": 24000,
    "channels": 1,
    "duration_ms": 1800,
    "text_cues": [
      { "text": "需要", "at_ms": 0, "duration_ms": 420 },
      { "text": "合成的文本", "at_ms": 420, "duration_ms": 1380 }
    ]
  }
}
```

服务端应在流端点建立后立即返回 MCP 结果；流端点可以等待首批音频，但不能等待整句合成结束才创建。`stream-required` 收到 artifact 会产生 `tts-stream-unavailable`，避免无提示地退化回高首包延迟。

取消工具默认为 `tts_cancel_synthesis`，参数使用同一个 `request_id`。取消必须同时停止模型生成、关闭对应 HTTP 流并释放队列资源。Runtime 中断还会递增 generation，因此迟到结果不会重新进入当前计划。

## 兼容输入

`McpTtsAdapter` 按顺序识别：

1. `structuredContent.stream`；
2. `structuredContent.audio` 或直接 `structuredContent`；
3. MCP 标准 `audio` content block；
4. `text` content block 中的 JSON。

字段同时接受 camelCase 与 snake_case。整段音频可以用 URI，或 `data + audio/* mimeType`。`visemes`、`amplitude` 和可选 `textCues/text_cues` 会按时间排序；权重和电平钳制到 `0..1`。`text_cues` 用于聊天气泡/KTV 的字词对齐，只有严格拼接为当前 `displayText` 时 Runtime 才采用。畸形载荷、缺失流解码参数和请求 ID 不一致都不会进入播放器。

## Runtime 与播放器事件

播放器通过以下流式事实驱动 Runtime：

- `playback.buffering`：正在积累首播缓冲，尚未进入 speaking；
- `playback.started`：输出时间线到达首个可听采样，Runtime 才进入 speaking 并显示聊天气泡；
- `playback.level`：播放器从实际已解码采样计算的原始实时电平事实；Runtime 再按角色级 `LipSyncProfile` 映射口型；
- `playback.stalled` / `playback.recovered`：欠载与恢复；
- `playback.progress`：真实播放位置，用于 Timeline；
- `playback.completed` / `playback.failed`：输出时间线终态；完成后 Runtime 按聊天气泡配置延迟隐藏，失败则立即隐藏。

播放器优先使用 `AudioContext.getOutputTimestamp().contextTime`，不支持时才回退 `currentTime`；开始、进度、电平和结束都消费同一输出时钟。流创建成功后的 HTTP 断流或解码错误属于播放失败，而不是 TTS 准备失败。流式源不使用预计算 amplitude 推进嘴型；播放器应基于实际输出采样发送 `playback.level`。artifact 模式仍可按预计算 amplitude 降级。

## 本地 MCP Provider、配置与诊断

默认 `local` 模式会启动仓库根目录的独立 [`local-tts-mcp`](../local-tts-mcp/README.md) 服务。该服务使用官方 SDK 的有状态 Streamable HTTP transport，通过真实 TCP 端口暴露 `initialize`、`tools/list`、`tools/call` 和 session 生命周期，并通过另一个 HTTP endpoint 分块输出 PCM。Electron main 无论 `local` 还是 `mcp` 都创建相同的官方 MCP Client session，Renderer 始终只看到 IPC 后的 `McpClientPort`、`McpTtsAdapter` 和 HTTP `AudioStreamSource`。当前两端 MCP 已支持右键动态启停、JSON 配置热重载、连接测试和重连；TTS 的 Provider 切换延迟到 Runtime idle，完整语义见 [MCP 服务生命周期](mcp-services.md)。

网页开发壳没有 Electron main，因此使用严格 CSP 可运行的最小 Streamable HTTP JSON-RPC client 连接同一真实服务；服务端、MCP session、工具 schema 和 PCM 数据面没有降级。未在网页中直接打包官方 Client，是因为 SDK 1.29 的输出 schema 校验器需要动态代码生成，与页面 `script-src 'self'` 冲突。

本地 Provider 默认音色为固定 560 Hz 的 `jrpg-blip`，另保留按字素确定性映射四档音高的 `jrpg-blip-varied` 供 A/B 试听。二者都按 Unicode 字素生成短促提示音，标点生成静音停顿，并从准确的 PCM 采样帧返回 `duration_ms` 与逐字 `text_cues`。因此本地前台可直接听辨每字节奏，聊天气泡与 KTV 也能验证精确 cue 路径。真实 Qwen3-TTS MCP 的未知总时长、无 cue 流仍由相同 Adapter 的降级测试覆盖；应用没有针对本地音色的播放器旁路。

播放器不修改或伪造电平。Mao 资产 Profile 中的 `LipSyncProfile.gain` 为 `2.5`，Runtime 将当前提示音约 `0.224` 的稳定原始电平映射到约 `0.56` 的目标开口值，再通过 `attackMs/releaseMs/peakHoldMs` 形成最终 `ParamMouthOpenY` 包络。增益与时间响应都跟随模型资产，只改变嘴型，不改变 PCM、实际播放音量或 MCP 契约。

独立的“口型同步验收”通过本地服务 input schema 明确声明的 `test_fixture: "known-tone-v1"` 请求 PCM fixture，不再用特殊语音文本、URI 或专用播放器旁路。它仍通过真实 `tts_open_stream -> HTTP stream_url -> AudioStreamSource -> WebAudioPcmStreamPlayer`，可听声音、`playback.level` 和模型参数验收都来自同一份 PCM。该字段只在 `local` 模式注入，外部 MCP 模式不会收到测试参数。详细先验时间表和阈值见 [先验铃声流与口型时点验收](audio-lip-sync-acceptance.md)。关键配置见 `.env.example`：

```text
DESKTOP_CHAR_TTS_MODE=local
DESKTOP_CHAR_TTS_LOCAL_MCP_HOST=127.0.0.1
DESKTOP_CHAR_TTS_LOCAL_MCP_PORT=8766
DESKTOP_CHAR_TTS_LOCAL_DELAY_MS=15
DESKTOP_CHAR_TTS_LOCAL_RATE=1
DESKTOP_CHAR_TTS_LOCAL_CHAR_MS=232
DESKTOP_CHAR_TTS_LOCAL_MIN_MS=500
DESKTOP_CHAR_TTS_SAMPLE_RATE_HZ=24000
DESKTOP_CHAR_TTS_CHANNELS=1
DESKTOP_CHAR_TTS_MCP_TOOL=tts_open_stream
DESKTOP_CHAR_TTS_MCP_CANCEL_TOOL=tts_cancel_synthesis
DESKTOP_CHAR_TTS_REQUEST_ID_ARGUMENT=request_id
DESKTOP_CHAR_TTS_FORMAT=pcm_s16le
```

执行验证：

```bash
npm run check
npm run test:local-mcp
npm run diagnose:tts
npm run test:smoke
```

诊断最后一行必须包含 `{"event":"tts.diagnostic.result","passed":true}`。诊断会启动真实本地服务，用官方 Client 完成 session 初始化、调用工具并消费 HTTP PCM，同时保留一个纯 Adapter 的虚拟远程响应单元检查。`health()` 找不到工具时为 `unavailable`；工具存在但没有输出 schema 时为 `degraded`；只有发现带输出 schema 的目标工具时为 `ready`。应用没有 Mock 回退：选择 `mcp` 后远端不可用会明确失败。

## 尚未由 Adapter 解决的问题

Adapter 只让下游具备消费流的能力，不会把一个整句返回的模型 API 自动变成真正的流式生成。若服务端直接调用 Qwen3-TTS 当前公开 `generate_*()`，仍需等待完整波形，HTTP 流只能延后输出。服务端必须使用未来的官方流式 API，或在模型 code 生成与 tokenizer decode 层实现经过验证的增量管线，才能获得实际首包延迟收益。
