# MCP 服务生命周期与角色接入接口

## 两条独立链路

DesktopChar 同时管理两个职责相反的 MCP 端点：

```text
DesktopChar --MCP Client--> 语音合成 MCP Server --HTTP audio--> Player

External Agent --MCP Client--> DesktopChar 角色接入 MCP Server
                                      |
                                      v
                                Avatar Runtime
```

- **语音合成 MCP**：技术标识为 TTS MCP，DesktopChar 是 Client。`local` 模式由 Electron 启停仓库内的 `local-tts-mcp`，`mcp` 模式只连接外部 Qwen3-TTS 等 Server，不负责启动任意外部进程。
- **角色接入 MCP**：技术标识为 `characterMcp`，DesktopChar 是 Server。外部 Agent 通过它读取角色状态与能力、提交完整 `PerformancePlan`、请求中断。原有 `127.0.0.1:17373` HTTP API 保留为兼容应用 case，两者进入同一白名单 IPC 和 Runtime 事件入口。

Electron main 的 `McpServicesController` 独占配置 revision、服务生命周期、MCP session、重连计时器和连接测试结果。Renderer 右键 UI 只发送启停、重载和测试意图；Avatar Runtime 仍是角色状态唯一所有者。

## 右键菜单

角色右键菜单的“MCP 服务”分区提供：

- `角色接入 MCP` checkbox：动态绑定/关闭角色接入 MCP Server；
- `语音合成 MCP` checkbox：动态连接/断开 TTS Provider；
- `测试 MCP 连接`：一次同时探测两端。角色接入侧使用官方 MCP Client 建立临时 session 并确认四个角色工具，语音合成侧重新执行 `tools/list` 并确认合成工具；两端通过、失败或未启用的结果汇总到角色自身聊天气泡；
- `重新加载 MCP`：在 Runtime 空闲时立即读取配置文件并应用新 revision；完成后通过角色聊天气泡显示配置是否变化及两端服务状态，读取失败时显示错误与现有服务状态。

四项入口严格按上述顺序排列。菜单状态直接投影 main 的服务快照，不把 checkbox 自身当作事实来源。状态包括 `disabled`、`starting`、`ready`、`degraded`、`reload-pending`、`reloading`、`reconnecting` 和 `stopping`；重连次数、下次重连时间、最近错误和最近连接测试也保存在同一快照。连接测试和手动重新加载的结果都不由菜单 DOM 直接显示或持有：Renderer 只把汇总文本作为 `presentation.chat-bubble-requested` 事件发送给 Avatar Runtime，由 Runtime 独占显示状态及关闭计时。

## 可热重载配置

复制样例后按设备修改：

```powershell
Copy-Item desktop-char.config.example.json desktop-char.config.json
```

实际文件 `desktop-char.config.json` 已加入 `.gitignore`。也可用 `DESKTOP_CHAR_MCP_CONFIG_PATH` 指定其他绝对或相对路径。配置优先级为：

```text
JSON 中明确提供的字段 > 进程环境变量 > 内置默认值
```

因此现有 `desktop:mcp` 环境变量启动方式保持兼容；只有 JSON 中出现的字段才覆盖对应环境变量。配置文件不存在时不会报错，应用完全沿用环境变量和默认值。

完整样例见 [`desktop-char.config.example.json`](../desktop-char.config.example.json)。顶层结构为：

```json
{
  "ttsMcp": {
    "autoStart": true,
    "mode": "local",
    "url": "http://127.0.0.1:8766/mcp",
    "toolName": "tts_open_stream",
    "cancelToolName": "tts_cancel_synthesis",
    "timeoutMs": 30000,
    "requestIdArgument": "request_id",
    "textArgument": "text",
    "format": "pcm_s16le",
    "local": { "host": "127.0.0.1", "port": 0 },
    "reconnect": { "initialDelayMs": 500, "maximumDelayMs": 10000 }
  },
  "characterMcp": {
    "autoStart": true,
    "host": "127.0.0.1",
    "port": 17374,
    "path": "/mcp",
    "reconnect": { "initialDelayMs": 500, "maximumDelayMs": 10000 }
  }
}
```

`autoStart` 只决定本次应用启动后的初始期望状态。用户在右键菜单做出的启停选择属于当前进程的应用状态，普通配置重载不会被文件中的 `autoStart` 反向覆盖。

main 持续监听配置文件；创建、保存、替换或删除文件都会触发防抖后的重新读取。非法 JSON、非 loopback 的角色监听地址、非法端口/音频格式或错误的重连区间不会替换当前有效配置；错误会进入配置状态并显示在菜单，旧服务继续工作。右键“重新加载”使用同一事务。

### 语音合成切换事务

语音合成 MCP 的工具调用结束后，实际 HTTP 音频流仍可能正在播放。关闭旧 MCP session 或内置 Provider 可能同时截断数据面，因此热重载遵守 Runtime 空闲边界：

```text
config changed while speaking
  -> reload-pending（旧 revision 继续服务当前语音）
  -> Runtime snapshot returns idle
  -> close old session/provider
  -> create and test candidate revision
  -> atomically publish new runtime config
```

Renderer 中的 `ReloadableTtsAdapter` 是稳定代理，`TtsRuntimeEffectHandler` 不随配置重建。新 revision 只替换代理 delegate；Runtime、Player 与 Live2D Renderer 均不持有 MCP session。用户主动禁用语音合成的 checkbox 在 Runtime busy 时不可操作，避免从 UI 中途截断一句话。

### 角色接入切换事务

角色接入 MCP 不持有播放资源，可以独立停止和重新绑定。Server 重启会主动关闭旧 session；外部 Agent 必须把 MCP transport 断开视为可恢复事件并重新执行 `initialize`。DesktopChar 负责监听端口的指数退避重绑，但不能替外部 Client 恢复已经失效的 session ID。

## 自动重连与连接测试

两端都使用 `initialDelayMs * 2^(attempt-1)` 的指数退避，并在 `maximumDelayMs` 截断：

- 语音合成：连接、`tools/list` 或 `tools/call` 的传输错误会关闭缓存 session 并进入重连；为避免合成请求重复，失败的 `tools/call` 不自动重放，后续请求使用新 session。
- 角色接入：端口占用等监听失败会重试绑定；成功后立即使用官方 Client 做一次真实连接测试。
- 用户禁用服务会取消对应重连计时器并清空 `nextReconnectAt`。
- 显式连接测试会刷新 `lastTest.status`、时间、耗时和诊断文本。

## 角色接入 MCP 工具

角色接入 MCP 默认监听 `http://127.0.0.1:17374/mcp`，只允许 loopback host。端口设为 `0` 时由操作系统选择临时端口，适用于测试。

| 工具 | 输入 | 作用 |
| --- | --- | --- |
| `desktop_char_get_state` | `{}` | 返回 renderer readiness 与完整 Runtime snapshot |
| `desktop_char_get_capabilities` | `{}` | 返回角色、聊天气泡、语音合成与命令能力 |
| `desktop_char_perform` | `{ "plan": PerformancePlan }` | 角色 ready 且 idle 时提交经过完整校验的表演计划 |
| `desktop_char_interrupt` | `{}` | 请求 generation-safe Runtime 中断 |

角色接入 MCP 与兼容 HTTP API 共用同一个 `validatePerformancePlan()`，因此 segment ID/sequence、speech/display text、emotion/action 白名单和聊天气泡 cue 校验完全一致。MCP 工具不允许直接写 Live2D 参数或跳过 Runtime。

角色接入 MCP 可在语音合成 MCP 未启用时继续接受计划。此时每个合成失败的 segment 由 Runtime 按 sequence 进入 `presenting` 纯文本回退：只显示完整聊天气泡，不产生声音、口型、流式追加或 KTV 高亮；显示时长按非空白字符数估算。`desktop_char_get_capabilities` 会公开该回退能力和计时参数。

## 验证

```powershell
npm run test:desktop
npm run test:desktop-smoke
```

单元/集成测试覆盖：两端动态启停、官方 Client 工具发现、单次双端连接测试、配置解析、文件 watcher、Runtime busy 延迟切换、外部语音合成服务断线退避，以及角色接入端口冲突解除后的自动重绑。桌面 smoke 通过真实右键菜单关闭并重新启用两端服务，验证手动重新加载的聊天气泡回执，再触发双端连接测试，验证两端状态与 Runtime 聊天气泡结果后继续执行语音播放。
