# 本地语音合成 MCP 参考服务（Local TTS MCP）

该目录是与桌面角色应用相对独立、可单独启动的真实 MCP 接入样例。只有“合成模型”由确定性的 `jrpg-blip` 逐字提示音生成器代替；以下边界均使用正式实现：

- 官方 `@modelcontextprotocol/sdk` 的有状态 Streamable HTTP Server Transport；
- `initialize`、session ID、`tools/list`、`tools/call` 与 session 关闭；
- MCP 控制面和 HTTP PCM 数据面分离；
- `tts_status` 发布固定 Profile、就绪语义与可选测试能力；
- `tts_open_stream` 尽快返回单次消费的 `stream_url`；
- `tts_cancel_synthesis` 同时终止生成和正在输出的 PCM；
- loopback-only 监听、Host 校验、Origin/CORS 白名单、流过期和重复消费保护；
- 完整的 input/output schema，可被 MCP Client 的工具发现和结构校验直接使用。

它不是 Renderer 内的 Mock Adapter，也没有 `mock://`、内存 URI 或播放器特判。替换成 Qwen3-TTS 时应保留服务边界，只替换 [`jrpg-blip.mjs`](jrpg-blip.mjs) 的计划与 PCM 增量生成器。

## 独立运行

在仓库根目录执行：

```powershell
npm install
npm run tts:local-mcp
```

默认端点：

```text
MCP: http://127.0.0.1:8766/mcp
PCM: http://127.0.0.1:8766/audio/{opaque-stream-token}
```

桌面版 `npm run desktop` 默认通过 `managed` 生命周期执行该独立入口，再经正式 MCP session 连接；Electron 控制器不再直接创建 `createLocalTtsMcpService()`。`npm start` 也会先启动相同子进程，通过 Profile 就绪检查后再启动网页开发服务器。

可配置项：

```text
DESKTOP_CHAR_TTS_LOCAL_MCP_HOST=127.0.0.1
DESKTOP_CHAR_TTS_LOCAL_MCP_PORT=8766
DESKTOP_CHAR_TTS_LOCAL_DELAY_MS=15
DESKTOP_CHAR_TTS_LOCAL_RATE=1
DESKTOP_CHAR_TTS_LOCAL_CHAR_MS=232
DESKTOP_CHAR_TTS_LOCAL_MIN_MS=500
DESKTOP_CHAR_TTS_SAMPLE_RATE_HZ=24000
DESKTOP_CHAR_TTS_CHANNELS=1
```

独立服务只允许绑定 loopback。managed 启动要求配置的 `connection.url` 与服务端口一致，默认使用 `8766`；端口冲突会作为所有权错误报告，不会静默接管其他进程。

## MCP 工具

工具集合遵循 [DesktopChar TTS MCP Profile v1](../docs/tts-mcp-integration.md)。工具名和关键参数名固定，不通过 DesktopChar 配置映射。

### `tts_status`

输入为空对象。该调用无副作用，不加载模型，返回 `desktop-char.tts.streaming` Profile v1、`ready + accepting_requests=true` 以及格式、voice、`text_cues` 和 `known-tone-v1` 测试能力。

### `tts_open_stream`

请求示例：

```json
{
  "request_id": "g3:segment-0",
  "text": "需要合成的文本",
  "delivery": "stream-required",
  "format": "pcm_s16le",
  "language": "Chinese",
  "voice": "jrpg-blip",
  "instruction": "optional-style",
  "rate": 1.0
}
```

返回示例：

```json
{
  "stream": {
    "request_id": "g3:segment-0",
    "delivery": "stream",
    "stream_url": "http://127.0.0.1:8766/audio/opaque-token",
    "mime_type": "audio/pcm",
    "codec": "pcm_s16le",
    "sample_rate_hz": 24000,
    "channels": 1,
    "requested_rate": 1.0,
    "effective_rate": 1.0,
    "rate_mode": "native",
    "duration_ms": 1779,
    "text_cues": [
      { "text": "需", "at_ms": 45, "duration_ms": 232 },
      { "text": "要", "at_ms": 277, "duration_ms": 232 },
      { "text": "合", "at_ms": 509, "duration_ms": 232 },
      { "text": "成", "at_ms": 741, "duration_ms": 232 },
      { "text": "的", "at_ms": 973, "duration_ms": 232 },
      { "text": "文", "at_ms": 1205, "duration_ms": 232 },
      { "text": "本", "at_ms": 1437, "duration_ms": 232 }
    ]
  }
}
```

工具返回时整句 PCM 尚未全部产生。数据端点不发送 `Content-Length`，使用 HTTP chunked body 增量输出。参考 Provider 提供 `jrpg-blip` 与 `jrpg-blip-varied`；省略 `voice` 时使用前者，声明其他 voice 会得到明确的 schema 错误。

普通字素各产生一个短促电子音，使用 `Intl.Segmenter` 保持中文和组合 Emoji 的可见字符边界。默认字间隔为 232 ms；`，、,` 在普通间隔上额外停顿 160 ms，`；：;:` 额外 200 ms，`。！？.!?` 额外 260 ms，省略号额外 320 ms；标点本身不发声。`rate` 会等比缩放逐字间隔与停顿。返回的 `duration_ms` 和逐字 `text_cues` 直接由 PCM 采样帧换算，因此冒泡、KTV、播放电平和口型共享同一时间线。

音色峰值为旧版的 70%（`0.224`）。默认 `jrpg-blip` 的所有字素固定使用 560 Hz 基频；可选 `jrpg-blip-varied` 保留旧版逐字变化效果，从 500、560、620、680 Hz 中按字素稳定映射。同一段文本每次得到相同音高序列，因此可重复测试，它不是运行时随机数。两种 voice 的字速、音量、cue 与取消语义完全相同。波形由正弦基频和少量二、三次谐波构成，并使用 6 ms 淡入与 14 ms 淡出，不混入有采样跳变的方波成分。

桌面角色通过资产侧 `DesktopChar.character.json` 的 `LipSyncProfile.gain=2.5` 放大口型响应：`0.224` 的稳定 PCM 电平约映射为 `0.56` 的嘴部开合，但扬声器音量不变。Runtime 还使用该 Profile 的 `attackMs/releaseMs/peakHoldMs` 平滑逐字短音，避免每个字符都瞬间张嘴闭嘴。以上配置属于客户端角色资产校准，不属于 MCP 合成参数，也没有为本地提示音建立特殊口型旁路。

`DESKTOP_CHAR_TTS_LOCAL_RATE` 配置服务端默认语速，范围为 `0.5..2.0`，`1` 是标准速度，值越大越快。MCP 单次请求中的 `rate` 优先于服务默认值；无论采用哪一层配置，响应中的 `requested_rate`、`effective_rate`、`duration_ms` 和 cue 时间都会反映最终速率。示例：

```powershell
$env:DESKTOP_CHAR_TTS_LOCAL_RATE = "0.8"
npm run tts:local-mcp
```

`jrpg-blip` 的元数据是可精确计算的；未知总长度与无 `text_cues` 的降级路径继续由 Adapter 单元测试及真实外部 Qwen3-TTS 语音合成 MCP 覆盖，不需要让本地前台声音故意退化。

可在设备配置中选择保留的变化音调版：

```json
{
  "ttsMcp": {
    "synthesis": { "voice": "jrpg-blip-varied" }
  }
}
```

`test_fixture: "known-tone-v1"` 是仅供仓库前台验收使用的显式扩展。正常 Agent 和生产 MCP 不应发送它；前台只有在 `tts_status.capabilities.test_fixtures` 声明该值时才会启用并注入，不根据 Provider 名称或生命周期特判。

### `tts_cancel_synthesis`

```json
{ "request_id": "g3:segment-0" }
```

取消按 MCP session 与 request ID 联合寻址，避免不同客户端使用相同 request ID 时互相影响。服务会停止生成、结束已打开的 chunked PCM 响应并清理未打开流。预期取消使用正常 HTTP 流结束，避免 Chromium 把主动取消误报为 `ERR_INCOMPLETE_CHUNKED_ENCODING`。

## 生命周期与替换边界

```text
MCP initialize/session
  -> tools/list + tts_status
  -> tts_open_stream
       -> register synthesis job
       -> return opaque HTTP URL
  -> GET /audio/{token}
       -> claim once
       -> generate/write PCM chunks with backpressure
       -> remove job on finish/disconnect
  -> tts_cancel_synthesis
       -> abort generator + close stream + remove job
  -> MCP DELETE/session close
       -> cancel every job owned by that session
```

接入真实 Qwen3-TTS 时：

1. 保留 MCP 工具 schema、session/request ID、单次 URL 和取消语义。
2. 把合成 job 接到模型的增量生成器；不要在 `tts_open_stream` 内等待整句波形。
3. 每次模型产出转换为声明的 PCM 格式后写入 HTTP response，并尊重 backpressure。
4. 将 MCP cancel、HTTP 客户端断开和服务关闭统一传入模型任务的取消信号。
5. 若新增 `text_cues`、sample timeline 或生成进度，遵循 [流式扩展说明](../docs/tts-mcp-streaming-extension.md)，不要改变音频播放时钟的所有权。

## 验证

```powershell
npm run test:local-mcp
npm run diagnose:tts
npm run test:smoke
npm run test:desktop-smoke
```

测试使用官方 MCP Client 连接实际 TCP 端口，覆盖：

- session 初始化、工具发现及 input/output schema；
- `jrpg-blip` 每字短音、Unicode 字素、标点静音停顿及 sample-aligned `text_cues`；
- MCP 返回流描述后实际获取 chunked PCM；
- PCM URL 单次消费和跨站 Origin 拒绝；
- 播放中的 MCP cancel 与资源回收；
- 显式先验铃声 fixture；
- 网页与 Electron 的完整 Adapter、播放器、口型和冒泡链路。
