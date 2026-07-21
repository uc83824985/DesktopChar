# Qwen3-TTS MCP 流式扩展说明

## 目标与适用范围

本文面向 Qwen3-TTS MCP 服务实现者，定义 DesktopChar 当前需要的 `tts_open_stream` 扩展边界，以及可从 Qwen3-TTS 底层 codec/decoder 直接提供、但暂不要求客户端消费的时序信息。

设计目标：

- MCP 只负责合成控制和尽快返回音频流描述；
- HTTP 音频端点只传连续原始 PCM，不混入 JSON 或文本标记；
- DesktopChar 播放器负责缓冲、实际播放位置、实时电平和完成事实；
- Avatar Runtime 继续是角色状态唯一所有者；
- 语速可以作为合成参数和聊天气泡降级校准依据，但不能伪装成字词强制对齐；
- 新字段采用向后兼容的可选扩展，当前客户端可忽略未知字段。

```text
MCP control plane       HTTP audio plane       optional timing plane
tts_open_stream   ->    raw PCM stream    +     generation events
tts_cancel_synthesis    owned by player         owned by TTS service
       |                       |                         |
       `---- stream descriptor + sample timebase -------'
```

## 当前接入结论

### 现在需要 MCP 支持

1. 保持现有 `tts_open_stream` 请求和流描述兼容；
2. 新增可选 `rate` 请求参数，并明确是否真正生效；
3. 保证音频流格式、采样率、声道和请求 ID 准确；
4. 合成取消时关闭流并释放请求资源；
5. 不等待整句完成后才返回 `stream_url`。

### 推荐由 MCP 现在预留、客户端后续接入

1. sample-based 生成进度事件；
2. codec frame 与 PCM sample 的映射；
3. `finished`、`cancelled`、`error` 明确终态；
4. 最终 `total_samples` 和 `duration_ms`；
5. 音色/语言维度的稳定语速校准提示。

### 暂不要求

- 字、词、音素或 viseme 强制对齐；
- TTS 侧播放百分比、暂停、音量或播放器状态；
- 在 raw PCM 中内嵌元数据；
- 单次合成过程中动态改变语速；
- 让 MCP 管理 DesktopChar 的消息队列、聊天气泡或角色状态。

## `tts_open_stream` 请求

推荐工具签名：

```python
def tts_open_stream(
    request_id: str,
    text: str,
    delivery: str = "stream-required",
    format: str = "pcm_s16le",
    language: str = "Chinese",
    voice: str | None = None,
    instruction: str | None = None,
    rate: float | None = None,
) -> dict:
    ...
```

字段约束：

| 字段 | 当前级别 | 约束与语义 |
| --- | --- | --- |
| `request_id` | 必需 | 同一 MCP session 内唯一；取消和所有流事件复用该 ID |
| `text` | 必需 | 实际合成文本；不能为空白字符串 |
| `delivery` | 必需 | DesktopChar 默认发送 `stream-required` |
| `format` | 必需 | 当前推荐 `pcm_s16le`，兼容 `pcm_f32le` |
| `language` | 可选 | Qwen 支持的语言名；省略时使用服务默认值 |
| `voice` | 可选 | 持久音色 ID 或 voice anchor；省略时使用已加载音色 |
| `instruction` | 可选 | 情绪、风格或说话方式描述 |
| `rate` | 新增可选 | 归一化合成语速倍率，`1.0` 表示音色默认语速 |

### `rate` 语义

推荐接受范围为 `0.5..2.0`，超出范围应报参数错误或显式钳制，不能静默接受任意值。

- `rate = 1.0`：音色默认合成语速；
- `rate < 1.0`：更慢；
- `rate > 1.0`：更快；
- 它描述 TTS 合成目标，不是播放器 `playbackRate`；
- 它不能保证音频时长严格按 `1 / rate` 缩放；
- 若底层只能把数值转换为自然语言 instruction，应在响应中声明 `rate_mode = "instruction"`；
- 若底层不支持，应声明未应用，不能回报虚假的 `effective_rate`。

当前 DesktopChar 的 `TtsSynthesisRequest` 和 `McpTtsAdapter` 已能发送 `rate`，但应用配置暂未公开全局语速开关。MCP 可以先实现该字段；没有收到 `rate` 时必须保持现有行为。

## MCP 首次响应

控制面应在流会话创建成功后立即返回，不能为了计算最终时长或文本对齐而等待整句合成。

最小兼容响应：

```json
{
  "stream": {
    "request_id": "g3:segment-0",
    "delivery": "stream",
    "stream_url": "http://127.0.0.1:8766/audio/g3%3Asegment-0",
    "mime_type": "audio/pcm",
    "codec": "pcm_s16le",
    "sample_rate_hz": 24000,
    "channels": 1
  }
}
```

推荐扩展响应：

```json
{
  "stream": {
    "request_id": "g3:segment-0",
    "delivery": "stream",
    "stream_url": "http://127.0.0.1:8766/audio/g3%3Asegment-0",
    "events_url": "http://127.0.0.1:8766/audio/g3%3Asegment-0/events",
    "mime_type": "audio/pcm",
    "codec": "pcm_s16le",
    "sample_rate_hz": 24000,
    "channels": 1,
    "timebase": "samples",
    "codec_frame_rate_hz": 12.5,
    "samples_per_codec_frame": 1920,
    "requested_rate": 1.0,
    "effective_rate": 1.0,
    "rate_mode": "native",
    "presentation_hints": {
      "characters_per_second": 8.2,
      "basis": "voice-language-profile",
      "confidence": "calibrated"
    }
  }
}
```

扩展字段说明：

| 字段 | 级别 | 说明 |
| --- | --- | --- |
| `events_url` | 推荐预留 | 生成时序事件的 SSE/NDJSON 端点；当前 DesktopChar 尚未消费 |
| `timebase` | 推荐 | 固定为 `samples`；避免浮点毫秒累计误差 |
| `codec_frame_rate_hz` | 可选 | Qwen3-TTS 12Hz 模型实际为 12.5Hz |
| `samples_per_codec_frame` | 可选 | 24kHz 12Hz tokenizer 通常为 1920 |
| `requested_rate` | 使用 `rate` 时推荐 | 调用方请求值 |
| `effective_rate` | 使用 `rate` 时推荐 | 服务实际采用值；未知时省略 |
| `rate_mode` | 使用 `rate` 时推荐 | `native`、`instruction`、`profile-default` 或 `unsupported` |
| `presentation_hints` | 可选 | 音色统计提示，不是字词对齐结果 |
| `duration_ms` | 条件可选 | 只有无需阻塞即可准确获得时返回；流创建时未知则省略 |
| `text_cues` | 未来可选 | 只有真实对齐结果可用时返回，禁止用 chunk 边界伪造 |

`characters_per_second` 按合成输入 `text` 的 Unicode code point 统计。它只适合配置稳定音色的视觉渐显降级；当 `displayText` 与 `speechText` 不同、文本包含大量符号或语言不适合字符计数时，DesktopChar 应继续使用应用侧配置。

## HTTP PCM 数据面

音频端点必须返回连续裸 PCM：

```http
Content-Type: audio/pcm
Cache-Control: no-store
X-Audio-Codec: pcm_s16le
X-Sample-Rate-Hz: 24000
X-Channels: 1
```

要求：

- `pcm_s16le` 每采样每声道 2 bytes；
- `pcm_f32le` 每采样每声道 4 bytes；
- 不得假设一次 HTTP `yield` 等于一个 codec frame；
- 不得把 JSON、长度前缀或事件文本混入 PCM；
- chunk 可以任意拆分，客户端会按采样帧宽度保留尾部字节；
- 正常完成、取消和失败最终都要关闭数据流，但失败原因应通过时序事件或状态接口额外公开。

MCP 可以根据实际输出字节持续计算：

```text
sample_count = byte_count / (bytes_per_sample * channels)
sample_start = previous_sample_start + previous_sample_count
```

这组 sample offset 是生成音频时间线，不是设备实际播放位置。DesktopChar 播放器仍以 Web Audio 输出时钟产生 `playback.started/progress/completed`。

## 可选时序事件

当前客户端无需依赖这些事件即可完成播放和口型；MCP 若能直接访问 Qwen codec/decoder 底层，建议现在保留字段，避免以后重新定义协议。

### 音频生成块

```json
{
  "event": "audio_chunk",
  "request_id": "g3:segment-0",
  "sequence": 3,
  "codec_frame_start": 12,
  "codec_frame_count": 4,
  "sample_start": 23040,
  "sample_count": 7680,
  "generated_at_monotonic_ms": 85342.7,
  "is_final": false
}
```

约束：

- `sequence` 从 0 开始严格递增；
- `sample_start` 单调递增且不得重叠；
- 无静音补洞时，相邻事件应满足 `next.sample_start = current.sample_start + current.sample_count`；
- `generated_at_monotonic_ms` 只用于诊断生成抖动，不用于驱动播放或聊天气泡；
- 网络读取 chunk 不保证与该事件一一对应，消费者必须使用 sample offset。

### 正常完成

```json
{
  "event": "finished",
  "request_id": "g3:segment-0",
  "total_codec_frames": 31,
  "total_samples": 59520,
  "duration_ms": 2480,
  "finish_reason": "eos"
}
```

`duration_ms` 必须由最终采样数计算：

```text
duration_ms = total_samples * 1000 / sample_rate_hz
```

### 取消与错误

```json
{
  "event": "cancelled",
  "request_id": "g3:segment-0",
  "generated_samples": 23040,
  "reason": "client-request"
}
```

```json
{
  "event": "error",
  "request_id": "g3:segment-0",
  "generated_samples": 23040,
  "code": "decoder-failed",
  "message": "decoder worker stopped"
}
```

raw PCM 流关闭本身不能区分正常 EOF 和失败，所以终态事件不能被一个统一的 `None` 队列哨兵替代。

### 文本输入轨道诊断

Qwen 双轨生成在流式文本输入模式下可以知道某个 `generation_step` 使用了哪个文本 token。若 MCP 暴露该信息，必须使用 `text_feed_*` 命名：

```json
{
  "event": "text_feed",
  "request_id": "g3:segment-0",
  "generation_step": 6,
  "text_token_index": 6,
  "char_start": 5,
  "char_end": 7
}
```

它只表示文本条件何时送入模型，不表示该字词何时在音频中发声。禁止将其转换成 `text_cues` 或用于精确 KTV 高亮。`non_streaming_mode=true` 时文本会整体预填，也不应产生这种逐 token 映射。

## 聊天气泡与语速校准边界

DesktopChar 当前聊天气泡同步优先级保持不变：

1. 真实 `text_cues`；
2. Agent 提供的 `bubble.cues`；
3. 已知最终音频时长；
4. `charactersPerSecond` 视觉降级。

稳定音色可以通过实测维护校准表：

```json
{
  "voice": "my_voice",
  "language": "Chinese",
  "rate": 1.0,
  "characters_per_second": 8.2,
  "sample_count": 30
}
```

建议至少覆盖多条包含停顿和不同长度的句子，使用最终音频时长计算中位数。`rate` 改变后可以用 `calibrated_cps * effective_rate` 作为初始估计，但仍应单独抽样验证，不能假设严格线性。

`charactersPerSecond` 最终仍由应用层决定，因为聊天气泡显示的是 `displayText`，而 MCP 合成的是 `speechText`。MCP 返回值只能作为提示，不能直接修改 Runtime 状态。

## 当前 `63` 服务的最小改造点

针对现有 `63-Background-TTS-MCP-Server.py`，服务侧可以按以下顺序迭代：

1. 为 `tts_open_stream()`、`ServiceProcessHost.open_audio_stream()` 和子进程 `open_audio_stream` action 增加可选 `rate`；
2. 子服务返回 `rate_mode` 和实际生效值，`63` 原样加入 `structuredContent.stream`；
3. 在 `synthesis_audio_chunk` 中保留或计算 `sequence/sample_start/sample_count`；
4. 将 `synthesis_finished` 扩展为包含 `total_samples/duration_ms/finish_reason`；
5. 区分 `finished/cancelled/error`，不要只向音频 queue 写入相同结束哨兵；
6. 需要对外公开生成事件时，再增加独立 `events_url`，不修改 raw PCM 数据格式；
7. 只有加入真实对齐器后才提供 `text_cues`。

如果 DesktopChar 和 MCP 不在同一台机器，`stream_url/events_url` 不能硬编码为 `127.0.0.1`，应通过显式 public base URL 配置生成可达地址。

## 验收清单

### 当前必须通过

- 不传 `rate` 时与旧版行为一致；
- `rate=1.0` 能成功合成，非法值产生明确错误；
- MCP 工具在流注册后返回，不等待整句合成完成；
- 首批 PCM 在 EOS 前到达；
- descriptor 与 HTTP headers 的 codec、采样率、声道一致；
- `tts_cancel_synthesis(request_id)` 关闭对应流并释放资源；
- 多请求事件始终按 `request_id` 隔离。

### 增强时序必须通过

- `sequence` 严格递增；
- 所有 `sample_start/sample_count` 连续且无重叠；
- PCM 总字节数与 `total_samples * channels * bytes_per_sample` 一致；
- `duration_ms` 与 `total_samples/sample_rate_hz` 一致；
- 正常、取消、失败产生不同终态；
- `text_feed` 不作为字词朗读时间输出；
- 未运行真实对齐器时不返回伪造的 `text_cues`。

## 客户端兼容状态

当前 DesktopChar 已消费：

- `request_id`、`delivery`、`stream_url/uri`；
- `mime_type`、`codec`、`sample_rate_hz`、`channels`；
- 可选 `duration_ms`、`text_cues`、`visemes`、`amplitude`；
- 请求参数 `voice/language/instruction/rate/format`；
- `tts_cancel_synthesis(request_id)`。

当前尚未消费：

- `events_url`；
- sample-based 生成事件；
- `requested_rate/effective_rate/rate_mode` 响应元数据；
- `presentation_hints`；
- 合成进行中的晚到 `text_cues`。

因此 MCP 可以先以增量字段实现这些扩展而不破坏当前接入；DesktopChar 后续只有在需要生成诊断、动态重定时或真实对齐时再扩展 Adapter 和 Runtime 事件。
