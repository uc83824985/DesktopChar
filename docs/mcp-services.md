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

- **语音合成 MCP**：技术标识为 TTS MCP，DesktopChar 是 Client。`managed` 生命周期由 Electron 执行配置脚本并持有子进程，`external` 生命周期只连接由用户或其他系统拥有的 Server。两者使用同一个 [TTS MCP Profile v1](tts-mcp-integration.md)，Adapter 不区分 Local TTS、Qwen3-TTS 或测试实现。
- **角色接入 MCP**：技术标识为 `characterMcp`，DesktopChar 是 Server。外部 Agent 通过它读取角色状态与能力、提交完整 `PerformancePlan`、请求中断。原有 `127.0.0.1:17373` HTTP API 保留为兼容应用 case，两者进入同一白名单 IPC 和 Runtime 事件入口。

Electron main 的 `McpServicesController` 独占配置 revision、服务生命周期、MCP session、重连计时器和连接测试结果。Renderer 右键 UI 只发送启停、重载和测试意图；Avatar Runtime 仍是角色状态唯一所有者。

初期契约测试使用的 `CharAgentMcpAdapter` 与这里的 `characterMcp` 不是同一接口：前者只把
单一 `char_generate_reply` 工具映射为 `CharAgentEndpoint`，后者控制角色表演。Char Agent
MCP 不进入 `conversation-runtime`，也不作为生产文本 Provider；默认单元测试仍注入 Fake
endpoint，官方 MCP Client 的 loopback 契约测试不启动真实模型、TTS、Electron 或 Live2D。
首版契约完成后不再扩展 Char MCP 能力，只保留必要的兼容修复。完整测试分层见
[单角色多 Agent 回复流水线开发说明](multi-agent-development.md)。

本地表情/动作规划服务不属于第三个 MCP。它虽然复用 `external / managed` 生命周期术语，
但只通过 OpenAI-compatible HTTP 接收 sealed 文本和当前 Live2D 动作目录，并返回受
JSON Schema 约束的建议。它由独立的 `PerformanceModelController` 管理状态和 owned
进程，不进入 `McpServicesController`。原因、Supervisor 边界和配置见
[本地表现模型接入设计](performance-model-integration.md)。

## 右键菜单

角色右键菜单的“接入服务”分区只使用面向用户的能力名称，提供：

- `表情动作推理` checkbox：动态启停本地表情/动作推理；关闭后使用规则回退，不阻塞文本、语音或
  外部角色控制；原“测试 Happy 表情资源”开发入口已移除；
- `外部角色控制` checkbox：动态绑定/关闭角色接入 MCP Server；
- `文本语音合成` checkbox：动态启停 TTS 能力；`managed` 同时启停所属子进程，`external` 只连接/断开；
- `测试服务连接`：通过应用服务测试注册表依次返回数组结果。表情动作推理探测健康端点；外部角色
  控制使用官方 MCP Client 建立临时 session 并确认角色工具；文本语音合成校验 Profile 强制工具
  及双向 Schema，再调用 `tts_status`。关闭项返回 `skipped/未启用`，单项失败被隔离为该项
  `failed`，不会让整次测试抛错或遗漏其他结果。

Task Manager 不再作为右键菜单中的独立服务开关；它默认由应用内部按配置启动和恢复，并在对话
面板中通过会话能力与连接状态体现。外部会话的 `ownership: external` 仍表示源窗口由外部应用
拥有，与 Task Manager 进程采用何种生命周期无关。菜单状态直接投影
main 的服务快照，不把 checkbox 自身当作事实来源。状态包括 `disabled`、`starting`、
`ready`、`degraded`、`failed`、`reload-pending`、`reloading`、`reconnecting` 和
`stopping`；重连次数、下次重连时间、最近错误和最近连接测试也保存在同一快照。

“重新加载配置”已移入独立的“应用配置 · rN”分区，因为统一 JSON 同时覆盖交互、窗口、Agent HTTP、当前角色 Profile 路径和两端 MCP，不再属于 MCP 专用操作。普通保存由文件监听自动加载；手动入口只用于立即复核或诊断监听异常。完成或失败结果仍通过 Runtime 持有的聊天气泡显示，配置错误时分区标题显示 last-good revision 和错误状态。

## 可热重载应用配置

两端 MCP 已使用统一应用配置 JSON；同一文件也承载拖动、窗口默认值、Agent HTTP 和当前角色 Profile 路径。资产校准参数和暂不迁移的环境变量边界见 [配置所有权与 JSON 重构方案](configuration.md)。

复制样例后按设备修改：

```powershell
Copy-Item desktop-char.config.example.json desktop-char.config.json
```

开发期文件 `desktop-char.config.json` 已加入 `.gitignore`；打包版本默认读取 Electron `userData/config.json`。也可用 `DESKTOP_CHAR_CONFIG_PATH` 指定其他绝对或相对路径；旧 `DESKTOP_CHAR_MCP_CONFIG_PATH` 在迁移期作为兼容别名。应用会把用户 JSON 作为对 `desktop-char.config.example.json` 默认预设的递归局部覆盖，配置优先级为：

```text
用户 JSON 中明确提供的字段 > 迁移期进程环境变量 > example 默认预设 > 内置硬编码初始值
```

`npm run desktop` 是唯一桌面启动入口；原 `desktop:mcp` 包装脚本已经移除。`DESKTOP_CHAR_CONFIG_PATH` 可快速切换设备局部覆盖，少量环境变量只保留为启动引导和迁移期 fallback。用户配置不存在时直接使用 example；example 也不存在时才使用代码兜底值。两份文件都受热重载监听，且一致性测试会阻止 example 与代码兜底默认值发生静默漂移。

完整样例和 JSON Schema 见 [`desktop-char.config.example.json`](../desktop-char.config.example.json)。`ttsMcp` 当前只选择 profile 名，具体 TTS Profile 从独立文件加载。顶层示例如下：

```json
{
  "$schema": "./apps/desktop/public/schemas/desktop-char.config.schema.json",
  "version": 1,
  "interaction": { "drag": { "holdDelayMs": 180 } },
  "window": {
    "defaultSize": { "width": 460, "height": 700 },
    "defaultMarginDip": 24,
    "alwaysOnTop": true
  },
  "agentHttp": { "enabled": true, "host": "127.0.0.1", "port": 17373 },
  "character": { "profile": "models/Mao/DesktopChar.character.json" },
  "ttsMcp": {
    "autoStart": true,
    "profile": "local"
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

对应的 TTS Profile 文件放在 `tts-mcp-profiles/<name>.json`。例如 `tts-mcp-profiles/local.json`
承载仓库内 Local TTS 的 managed 启动参数；`tts-mcp-profiles/qwen.json` 是无设备路径的
external Profile。需要托管本机 Qwen 进程时，复制为被 Git 忽略的 `qwen.local.json`，
补充本机启动路径，并把 `ttsMcp.profile` 设为 `qwen.local`。

`autoStart` 只决定本次应用启动后的初始期望状态。用户在右键菜单做出的启停选择属于当前进程的应用状态，普通配置重载不会被文件中的 `autoStart` 反向覆盖。

main 持续监听配置文件；创建、保存、替换或删除文件都会触发防抖后的重新读取。非法 JSON、非 loopback 的角色监听地址、非法端口/音频格式或错误的重连区间不会替换当前有效配置；错误会进入配置状态并显示在菜单，旧服务继续工作。右键“重新加载”使用同一事务。

### 语音合成切换事务

语音合成 MCP 的工具调用结束后，实际 HTTP 音频流仍可能正在播放。关闭旧 MCP session 或 managed Provider 可能同时截断数据面，因此热重载遵守 Runtime 空闲边界：

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

- 语音合成：连接、Profile 校验、周期 `tts_status` 或 `tools/call` 的传输错误会关闭缓存 session 并进入重连；`managed` 会重建所属进程，`external` 只重连。为避免合成请求重复，失败的合成调用不自动重放。
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

角色接入 MCP 与兼容 HTTP API 共用同一个 `validatePerformancePlan()`，因此 segment ID/sequence、speech/display text、emotion/action 能力和聊天气泡 cue 校验完全一致。显式 `actions[].action` 仅接受当前 Runtime snapshot 的 `capabilities.actions`；Agent 应先调用 `desktop_char_get_capabilities`，并在角色或配置变化后刷新缓存。接入层不再维护 `nod/shake/tap/greet` 等旧动作白名单。MCP 工具不允许直接写 Live2D 参数或跳过 Runtime。

角色接入 MCP 可在语音合成 MCP 未启用时继续接受计划。此时每个合成失败的 segment 由 Runtime 按 sequence 进入 `presenting` 纯文本回退：只显示完整聊天气泡，不产生声音、口型、流式追加或 KTV 高亮；显示时长按非空白字符数估算。`desktop_char_get_capabilities` 会公开该回退能力和计时参数。

## 验证

```powershell
npm run test:desktop
npm run test:desktop-smoke
```

单元/集成测试覆盖：服务测试注册顺序与异常隔离、表现推理健康探测、两端 MCP 动态启停、官方
Client 工具发现、配置解析、文件 watcher、Runtime busy 延迟切换、外部语音服务断线退避，以及
角色接入端口冲突解除后的自动重绑。桌面 smoke 使用独立随机端口，遍历表现推理、外部角色
控制和文本语音合成的全部 8 种开关组合；每组都执行数组连接测试并提交内部文本计划，验证
关闭表情动作推理只改变表现建议、关闭外部控制不影响内部计划、关闭文本语音合成稳定进入纯文本
回退，最终均返回 `idle` 且 renderer 不退出。
