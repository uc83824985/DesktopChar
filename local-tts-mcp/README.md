# Local TTS MCP reference service

该目录是与桌面角色应用相对独立、可单独启动的真实 MCP 接入样例。只有“合成模型”由确定性 PCM 生成器代替；以下边界均使用正式实现：

- 官方 `@modelcontextprotocol/sdk` 的有状态 Streamable HTTP Server Transport；
- `initialize`、session ID、`tools/list`、`tools/call` 与 session 关闭；
- MCP 控制面和 HTTP PCM 数据面分离；
- `tts_open_stream` 尽快返回单次消费的 `stream_url`；
- `tts_cancel_synthesis` 同时终止生成和正在输出的 PCM；
- loopback-only 监听、Host 校验、Origin/CORS 白名单、流过期和重复消费保护；
- 完整的 input/output schema，可被 MCP Client 的工具发现和结构校验直接使用。

它不是 Renderer 内的 Mock Adapter，也没有 `mock://`、内存 URI 或播放器特判。替换成 Qwen3-TTS 时应保留服务边界，只替换 `createSyntheticSpeechPcmStream()` 及其生成调度。

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

桌面版 `npm run desktop` 会在 `DESKTOP_CHAR_TTS_MODE=local` 时自动启动同一服务实现，但使用随机空闲端口避免冲突。`npm start` 会同时启动该服务与网页开发服务器。

可配置项：

```text
DESKTOP_CHAR_TTS_LOCAL_MCP_HOST=127.0.0.1
DESKTOP_CHAR_TTS_LOCAL_MCP_PORT=8766
DESKTOP_CHAR_TTS_LOCAL_DELAY_MS=15
DESKTOP_CHAR_TTS_LOCAL_CHAR_MS=90
DESKTOP_CHAR_TTS_LOCAL_MIN_MS=500
DESKTOP_CHAR_TTS_LOCAL_AMPLITUDE_MS=50
DESKTOP_CHAR_TTS_SAMPLE_RATE_HZ=24000
DESKTOP_CHAR_TTS_CHANNELS=1
```

独立服务只允许绑定 loopback。桌面自动启动时端口默认是 `0`，即由操作系统分配；独立运行与网页模式默认使用 `8766`。

## MCP 工具

### `tts_open_stream`

请求示例：

```json
{
  "request_id": "g3:segment-0",
  "text": "需要合成的文本",
  "delivery": "stream-required",
  "format": "pcm_s16le",
  "language": "Chinese",
  "voice": "optional-voice",
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
    "rate_mode": "native"
  }
}
```

工具返回时整句 PCM 尚未全部产生。数据端点不发送 `Content-Length`，使用 HTTP chunked body 增量输出。默认不伪造 `duration_ms`、`amplitude` 或 `text_cues`，从而覆盖实际流式模型在总长度未知时的客户端降级路径。

`test_fixture: "known-tone-v1"` 是仅供仓库前台验收使用的显式扩展。正常 Agent 和生产 MCP 不应发送它；外部 MCP 模式下桌面端也不会注入该字段。

### `tts_cancel_synthesis`

```json
{ "request_id": "g3:segment-0" }
```

取消按 MCP session 与 request ID 联合寻址，避免不同客户端使用相同 request ID 时互相影响。服务会停止生成、结束已打开的 chunked PCM 响应并清理未打开流。预期取消使用正常 HTTP 流结束，避免 Chromium 把主动取消误报为 `ERR_INCOMPLETE_CHUNKED_ENCODING`。

## 生命周期与替换边界

```text
MCP initialize/session
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
- MCP 返回流描述后实际获取 chunked PCM；
- PCM URL 单次消费和跨站 Origin 拒绝；
- 播放中的 MCP cancel 与资源回收；
- 显式先验铃声 fixture；
- 网页与 Electron 的完整 Adapter、播放器、口型和冒泡链路。
