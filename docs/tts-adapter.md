# TTS Adapter：流式优先契约

## 结论

`tts-mcp-adapter` 采用“控制面与数据面分离”的流式优先设计：

- MCP 工具是控制面，只接收合成参数并尽快返回流描述；
- HTTP 音频端点是数据面，播放器增量读取音频字节；
- `tts.segment-ready` 表示音频源已可打开，不表示整句已经合成完；
- 播放器报告缓冲、开始、卡顿、恢复、实时电平和完成事实；
- Avatar Runtime 仍是角色状态的唯一所有者。

这避免把整句音频以 MCP base64 结果返回后才开始播放。整段 WAV/MP3 仍作为兼容模式保留，但默认运行链路要求流式源。

## 模块边界

```text
Runtime tts.synthesize Effect
  -> TtsRuntimeEffectHandler
       -> TtsAdapter.prepare(request)
            |- MockTtsAdapter
            `- McpTtsAdapter -> MCP tts_open_stream
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
    "channels": 1
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

字段同时接受 camelCase 与 snake_case。整段音频可以用 URI，或 `data + audio/* mimeType`。`visemes`、`amplitude` 会按时间排序，权重和电平钳制到 `0..1`。畸形载荷、缺失流解码参数和请求 ID 不一致都不会进入播放器。

## Runtime 与播放器事件

播放器通过以下流式事实驱动 Runtime：

- `playback.buffering`：正在积累首播缓冲，尚未进入 speaking；
- `playback.started`：首个可听采样开始输出，Runtime 才进入 speaking；
- `playback.level`：播放器从实际已解码采样计算的实时口型电平；
- `playback.stalled` / `playback.recovered`：欠载与恢复；
- `playback.progress`：真实播放位置，用于 Timeline；
- `playback.completed` / `playback.failed`：数据面终态。

流创建成功后的 HTTP 断流或解码错误属于播放失败，而不是 TTS 准备失败。流式源不使用预计算 amplitude 推进嘴型；播放器应基于实际输出采样发送 `playback.level`。artifact 模式仍可按预计算 amplitude 降级。

## Mock、配置与诊断

默认离线 Mock 返回确定性的 24 kHz PCM 流描述，不启动真实 HTTP 服务；前台测试壳模拟缓冲、播放时钟和实时电平。关键配置见 `.env.example`：

```text
DESKTOP_CHAR_TTS_MOCK_DELIVERY=stream
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
npm run diagnose:tts
npm run test:smoke
```

诊断最后一行必须包含 `{"event":"tts.diagnostic.result","passed":true}`。`health()` 找不到工具时为 `unavailable`；工具存在但没有输出 schema 时为 `degraded`；只有发现带输出 schema 的目标工具时为 `ready`。是否退回 Mock 由应用装配层显式决定。

## 尚未由 Adapter 解决的问题

Adapter 只让下游具备消费流的能力，不会把一个整句返回的模型 API 自动变成真正的流式生成。若服务端直接调用 Qwen3-TTS 当前公开 `generate_*()`，仍需等待完整波形，HTTP 流只能延后输出。服务端必须使用未来的官方流式 API，或在模型 code 生成与 tokenizer decode 层实现经过验证的增量管线，才能获得实际首包延迟收益。
