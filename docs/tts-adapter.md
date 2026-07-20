# TTS Adapter 与虚拟 MCP 验证

## 目标与边界

`tts-mcp-adapter` 只负责把 `speechText` 合成为标准 `AudioSource`，不决定播放顺序、角色状态、表情或动作。Runtime 下发 `tts.synthesize` / `tts.cancel` Effect，`TtsRuntimeEffectHandler` 将结果反馈为 `tts.segment-ready` / `tts.segment-failed` 事实事件。

当前本机没有可用 TTS MCP 或 HTTP 服务，因此默认使用确定性的 `MockTtsAdapter`。真实服务接入时替换 Composition Root 中的 Adapter，不修改 Avatar Runtime。

## 模块结构

```text
Runtime Effect
  -> TtsRuntimeEffectHandler
       -> TtsAdapter
            |- MockTtsAdapter
            `- McpTtsAdapter -> McpClientPort -> HTTP / stdio transport
  -> Runtime TTS Event
```

- `MockTtsAdapter`：可配置延迟、字符时长、最小时长、音量采样间隔和失败模式。
- `McpTtsAdapter`：工具发现、调用超时、取消、参数映射、响应规范化和错误分类。
- `McpClientPort`：隔离具体 MCP SDK 与 transport。
- `VirtualMcpClient`：不启动进程或 HTTP 服务即可验证绑定契约。
- `TtsLogger`：输出结构化生命周期日志，不记录完整朗读文本。

## MCP 绑定契约

实际 MCP Client 只需实现：

```ts
interface McpClientPort {
  listTools(options?): Promise<Array<{ name: string; description?: string }>>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<{
    content: McpContentBlock[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }>;
}
```

接入 HTTP/stdio 时由外围包装官方 SDK 的 `listTools()` 和 `callTool()`。Adapter 会检查 `isError`，并按以下顺序读取结果：

1. `structuredContent.audio` 或直接 `structuredContent`；
2. MCP `audio` content block；
3. `text` content block 中的 JSON（兼容旧服务）。

标准载荷支持 `uri`，或 `data + audio/* mimeType`，以及可选 `durationMs`、`visemes`、`amplitude`。时间序列会排序，权重和音量会钳制到 0..1；畸形结构会产生 `tts-mcp-invalid-response`，不会进入播放器。

## Mock 与绑定参数

参数样例见根目录 `.env.example`。当前配置模型定义在 `packages/config`：

```text
DESKTOP_CHAR_TTS_MODE=mock
DESKTOP_CHAR_TTS_MOCK_DELAY_MS=15
DESKTOP_CHAR_TTS_MOCK_CHAR_MS=90
DESKTOP_CHAR_TTS_MOCK_MIN_MS=500
DESKTOP_CHAR_TTS_MOCK_AMPLITUDE_MS=50

DESKTOP_CHAR_TTS_MCP_TOOL=tts.synthesize
DESKTOP_CHAR_TTS_TIMEOUT_MS=30000
DESKTOP_CHAR_TTS_TEXT_ARGUMENT=text
DESKTOP_CHAR_TTS_FORMAT=wav
```

切换为 `mcp` 仅表示配置意图；必须同时在 Composition Root 注入一个已连接的 `McpClientPort`。如果 `health()` 未发现目标工具，状态为 `unavailable`，不得静默退回真实播放。是否降级到 Mock 由应用装配层显式决定。

## 日志与通过条件

日志事件：

- `tts.synthesis.started`
- `tts.synthesis.completed`
- `tts.synthesis.failed`
- `tts.health.checked`
- `tts.diagnostic.result`

执行：

```bash
npm run diagnose:tts
```

最后一行必须包含：

```json
{"event":"tts.diagnostic.result","passed":true}
```

前台测试接口为 `body[data-tts-health="ready"]`；`npm run test:smoke` 会等待该标记后再操作页面。完整通过标准：

1. `npm run check` 全部通过；
2. `npm run diagnose:tts` 的五项检查均为 `true`；
3. `npm run test:smoke` 成功加载模型、Mock TTS，并完成前台交互；
4. `npm audit --omit=dev` 为 0 漏洞。

## SDK 版本策略

截至 2026-07-20，官方 TypeScript SDK v2 仍标注为预发布，官方建议生产继续使用 v1.x。领域包因此不依赖 SDK 类型，只保留稳定 Client Port。等真实服务 transport 确定后，在应用层选用官方稳定 SDK 并实现该端口，避免协议升级迫使 Runtime 重构。
