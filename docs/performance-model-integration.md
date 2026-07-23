# 本地表现模型接入与生命周期设计

本文记录模块边界、生命周期和后续演进设计。实现或接入具体 Provider 时，必须遵循
[DesktopChar 表现模型 Provider 接入指南](performance-model-provider-integration.md)
中的当前有效 HTTP、输出、白名单、取消和验收契约。

## 设计结论

表情和 Live2D 动作选择暂由本地小模型完成。它与 TTS 一样需要支持 `external` 和
`managed` 两种进程所有权，但不使用 MCP：

```text
Performance Model Profile
          |
          v
Process Supervisor ── managed 才启动/停止进程
          |
          v
PerformanceInferencePort
          |
          +--> OpenAICompatiblePerformanceAdapter -> HTTP endpoint
          +--> CustomHttpPerformanceAdapter       -> HTTP endpoint
          |
          v
LocalPerformanceSuggestion
          |
          v
BehaviorPolicy -> performance.patch-requested

Port unavailable / timeout / invalid result
          |
          v
Deterministic rule fallback
```

MCP 适合角色工具发现、外部 Agent 控制面和 TTS 的状态/创建流/取消等语义工具。
本地表现模型只有“输入一个已 sealed segment，返回一个短结构化建议”的单一数据面，
使用 MCP 会增加一层工具 schema、session 和调用封装，却不带来新的生命周期能力。

`external / managed` 是 Supervisor 的通用生命周期语义，不应与 MCP 绑定。

## 引擎封装的是能力端口，不是模型

引擎层只定义模型无关的 `PerformanceInferencePort`：

```ts
interface PerformanceInferencePort {
  describe(): PerformanceInferenceCapabilities;
  plan(
    request: PerformancePlanningRequest,
    signal: AbortSignal,
  ): Promise<LocalPerformanceSuggestion>;
}

interface PerformancePlanningRequest {
  contractVersion: 'desktop-char.performance-planning.v1';
  requestId: string;
  planId: string;
  segmentId: string;
  segmentRevision: number;
  text: string;
  persona: PersonaPerformanceProjection;
  scene: ScenePerformanceProjection;
  avatar: AvatarPerformanceProjection;
  emotions: Emotion[];
  actions: PerformanceActionDescriptor[];
}
```

领域层不能出现 `Qwen3_5ForConditionalGeneration`、GGUF、CUDA layer、chat template、
OpenAI SDK 或 llama.cpp 参数。`LocalPerformancePlanner` 只调用这个 Port，并在失败时
使用规则回退。

替换路径分为三类：

1. 新模型仍提供 OpenAI-compatible chat：只更换 Profile 中的 endpoint、model 和启动命令；
2. 新服务使用不同 HTTP/gRPC 协议：新增一个外围 Adapter，领域契约不变；
3. 改用 ONNX 分类器：首版仍将它封装成 external/managed 本地服务；如果未来确有进程内
   推理需求，再实现同一 Port，当前 v1 不为此增加第三种生命周期。

Qwen3.5-2B 只是首个验证 Profile，不是模块名、协议名或持久化类型。禁止根据模型名称写
`if/else` Provider 特判。

Adapter 可以报告能力：

```ts
interface PerformanceInferenceCapabilities {
  structuredOutput: 'json-schema' | 'json-object' | 'prompt-only';
  thinkingControl: 'supported' | 'unsupported';
  streaming: boolean;
  maxContextTokens?: number;
}
```

`json-schema` Provider 直接接收动态 enum；其他 Provider 可以通过 prompt 获取目录，
但返回后仍必须经过完全相同的本地 schema 和 BehaviorPolicy 校验。模型升级不会改变
`LocalPerformanceSuggestion` 的语义。

## 所有权边界

| 组件 | 拥有 | 不拥有 |
| --- | --- | --- |
| Performance Model Supervisor | profile revision、endpoint readiness、owned 子进程、重启退避 | 模型内部队列、Avatar 状态、动作选择结果 |
| PerformanceInferenceAdapter | Provider 协议、请求映射、JSON schema、超时和结果归一化 | 启动脚本、进程终止、Live2D SDK |
| LocalPerformancePlanner | segment/Persona/Scene/Action 只读投影 | ConversationLedger、回复文本生成 |
| BehaviorPolicy | 白名单、冲突、冷却、提前量、随机抑制 | 模型进程与播放时钟 |
| Avatar PerformanceRuntime | generation、segment 状态、最终 cue 与呈现顺序 | Provider/模型实现 |

进程外 Adapter 永远接受一个已经准备好的 endpoint。它不能因为连接失败而自行执行脚本。

## external

`external` 表示推理服务由用户或其他系统拥有：

- DesktopChar 只连接配置 endpoint 并执行健康检查；
- 启用、禁用和热重载只建立/释放应用连接；
- 连接失败时进入 unavailable 并使用规则回退；
- DesktopChar 退出时不终止服务；
- Profile 不包含启动命令。

适用于手动运行的 llama.cpp、vLLM、SGLang、Transformers server 或共享推理服务。

## managed

`managed` 表示 DesktopChar 显式管理推理入口进程：

1. Electron main 以 `shell: false` 执行配置的 executable 和 args；
2. 等待 endpoint 健康检查通过；
3. 创建与 `external` 完全相同的 Adapter；
4. 进程异常退出后按 profile 决定是否重启；
5. 停用、重载或退出时先取消/过期 in-flight 请求，再结束 owned 进程树；
6. 超过 shutdown timeout 后强制终止。

不要求模型服务暴露 shutdown API。DesktopChar 只管理自己创建的入口进程，不管理
llama.cpp/vLLM 内部 worker、GPU allocator 或推理队列语义。

## Profile 草案

表现模型配置使用独立 profile，避免在应用根配置和领域类型中写死 Qwen 或 llama.cpp。
以下只是 Qwen3.5-2B + llama.cpp 的首个样例：

```json
{
  "profile": "desktop-char.performance-model.http.v1",
  "id": "qwen35-2b-llamacpp-local",
  "adapter": "openai-compatible-chat",
  "lifecycle": {
    "type": "managed",
    "start": {
      "executable": "C:\\path\\to\\llama-server.exe",
      "args": [
        "--model", "C:\\models\\qwen3.5-2b-q4.gguf",
        "--host", "127.0.0.1",
        "--port", "18090",
        "--ctx-size", "4096",
        "--n-gpu-layers", "99"
      ],
      "cwd": "C:\\path\\to\\llama.cpp"
    },
    "startupTimeoutMs": 30000,
    "shutdownTimeoutMs": 5000,
    "restartOnFailure": true
  },
  "connection": {
    "baseUrl": "http://127.0.0.1:18090/v1",
    "healthUrl": "http://127.0.0.1:18090/health",
    "model": "qwen3.5-2b"
  },
  "inference": {
    "promptProfile": "live2d-performance-v1",
    "thinking": false,
    "timeoutMs": 5000,
    "maxOutputTokens": 256,
    "temperature": 0.1
  }
}
```

这些数值是首轮测试配置，不是最终默认值。不同 server 的启动参数留在 profile，
`adapter` 选择传输映射实现，`connection.model` 对领域层是 opaque 字符串。
OpenAI-compatible Adapter 只依赖 chat endpoint、健康检查和结构化结果。
`promptProfile` 选择版本化的规范请求映射；模型特定采样参数留在 Profile，不能进入
`PerformancePlanningRequest` 或 Avatar Runtime。

当前仓库已经提供 `performance-model-service` 作为 Windows 开发环境。它用
Transformers lightweight server 暴露相同的 OpenAI-compatible 边界：

```powershell
npm run performance:bootstrap
npm run performance:start
# 另一个终端
npm run performance:smoke
```

该服务不是新的引擎模块，也不改变上述 Profile 契约。未来替换为 vLLM、SGLang、
llama.cpp 或专用分类器时，只替换 managed 启动命令、`connection.model` 和 Adapter
能力声明。Transformers 当前对本地 forced model 的 `/v1/models` 发现不完整；当前
Adapter 允许省略 `model`，由 forced-model server 使用启动时模型。其他 Provider
如果要求该字段则在配置中显式填写，连接测试不能把模型发现结果作为唯一 readiness
条件。

## 当前落地状态

当前代码已经建立并接入以下边界：

- `packages/performance-inference` 提供 `PerformanceInferencePort`、
  `OpenAiCompatiblePerformanceAdapter`、确定性规则回退、禁用实现和可取消的
  Runtime Effect Handler；
- `AvatarRuntime` 在 `plan.submitted` 后同时下发 `tts.synthesize` 和
  `performance.infer`，表现推理不会阻塞语音准备；
- 每个建议携带 `requestId + planId + segmentId + segmentRevision + generation`，
  Runtime 丢弃迟到、错段和旧 generation 结果；
- 模型只能补全原计划未显式提供的 emotion/actions；显式空动作数组也视为应用层的
  “不要自动动作”决定；
- 建议再次经过 Character capabilities、置信度、数量和 anchor 白名单校验。目前
  Live2D 时间映射只向模型开放 `segment-start`，`after-clause/segment-end` 保留在
  契约中，待文本—播放同步点可用后再开放；
- 当前段播放中才到达的有效建议会更新 `PerformanceTimeline`，已触发 cue 的 ID
  保留，因此不会重放旧表情或动作；
- 中断和 plan 完成会下发 `performance.cancel`。

桌面配置当前直接提供 external HTTP 入口，默认关闭：

```json
{
  "performanceInference": {
    "enabled": true,
    "provider": "qwen35-transformers",
    "baseUrl": "http://127.0.0.1:18090/v1",
    "timeoutMs": 5000,
    "maxOutputTokens": 256,
    "temperature": 0.1,
    "fallbackToRules": true
  }
}
```

修改 `desktop-char.config.json` 后由既有配置监听器热重载 Adapter；正在执行的旧请求
会取消，新配置从后续 plan 生效。当前阶段尚未把表现模型纳入 managed Supervisor，
因此需先独立执行 `npm run performance:start`。这不改变
`PerformanceInferencePort`，后续 managed 只增加进程所有权与 readiness，不进入
AvatarRuntime。

当前 `performanceInference.lifecycle` 只允许 `external`。右键菜单显示
“表情动作推理（外部）”，勾选表示允许 Adapter 使用已经存在的 endpoint，不表示
DesktopChar 获得或启动 Qwen 进程。连接失败时按配置进入规则回退并输出
`request.fallback`。

桌面右键菜单提供“表现设置 → 表情动作推理”复选项。该入口通过受控 IPC 修改 main
持有的运行时 enabled override，并立即向 renderer 广播完整有效配置；关闭时会取消
当前 in-flight 推理，开启后从新的 plan 开始请求。菜单不直接改写用户 JSON，执行
“重新加载配置”或文件监听到新 revision 时会清除临时 override，并重新采用
`performanceInference.enabled`，保证持久配置仍只有一个来源。

### 运行时日志

`npm run desktop` 的终端会转发 renderer 中以 `[performance]` 开头的结构化日志：

- `config.changed`：动态开关或配置热重载已经生效；
- `request.started`：Runtime 确实生成了一个待补全表情或动作的推理请求；
- `request.completed`：包含耗时、来源、表情和动作建议；
- `request.fallback`：主模型请求失败，正在使用确定性规则；
- `request.failed` / `request.cancelled`：请求失败或因打断、配置切换而取消。
- `expression.applied` / `expression.reset`：绑定的 Live2D expression 已实际应用或复位。

`request.completed` 的 `source` 是最直接的验收字段：`model` 表示 Qwen 服务实际返回
并通过了契约校验，`rules` 表示规则回退。消息段已显式指定 `emotion` 和 `actions`
时，Runtime 不会重复推理，因此仅看到 `config.changed` 是正常行为。

### 角色表情资源绑定

表现模型只返回白名单内的语义 emotion，不返回 `exp_02` 之类的资产编号。角色 sidecar
通过 `emotionBindings` 完成最后一段角色级映射：

```json
{
  "emotionBindings": {
    "neutral": { "expression": null },
    "happy": { "expression": "exp_02" }
  }
}
```

Timeline 命中 emotion cue 后，Runtime 同时更新唯一语义状态并发出
`renderer.set-expression`；渲染层调用 Live2D expression manager。计划完成和中断时
Runtime 明确发送 neutral/reset。这样替换模型时只需修改角色 sidecar，不需要修改
表现模型提示词、Runtime 分支或 Electron 代码。

桌面右键“表现设置 → 测试 Happy 表情资源”提交一个显式 `happy` cue，只验收
CharacterProfile、Runtime 和 Live2D expression 链路，不依赖 Qwen 是否在线。它与
聊天气泡排版测试、表现模型推理测试保持分离。

## 动态 JSON Schema

请求 schema 必须由当前 CharacterProfile 和 Renderer capabilities 生成：

- `emotion.emotion` 枚举只能来自 `allowedEmotions`；
- `actions[].actionId` 枚举只能来自当前已绑定的 ActionDescriptor；
- `anchor` 只允许 segment-start、after-clause、segment-end；
- action 数量、intensity、confidence 和 clause index 设置严格上下界；
- `additionalProperties=false`。

即使推理服务已做 constrained decoding，Adapter 和 BehaviorPolicy 仍需再次验证。
模型输出合法不等于动作在当前播放状态下可执行。

## 热重载与降级

- 配置更新会取消旧 Adapter 的 in-flight 请求；后续 managed profile 再增加独立
  `performanceModelRevision`；
- 新请求只发送给新 revision，旧请求结果携带原 revision；
- endpoint、模型或启动参数变化时，managed 重建 owned 进程，external 只重连；
- in-flight 请求最多等待其 2 秒 deadline；旧 revision 结果不得 patch 新 segment；
- 模型不可用、超时或 JSON 无效时立即使用规则/上一表情平滑回退；
- 模型恢复不重放已经开始或完成的 segment；
- Profile 热重载不修改 AvatarRuntime、播放器或 ConversationLedger。

## 与 TTS 并发

RTX 3070 上的验收必须使用真实组合负载，而不是分别测试模型：

- Qwen3-TTS 首包和持续生成；
- Qwen3.5-2B 表现规划；
- Live2D 每帧更新；
- PCM 播放、口型和聊天气泡。

调度优先级固定为 TTS 首包高于表现模型。若共享 GPU 导致 TTS 回退，优先降低表现模型
GPU layers、切换 0.8B/1.7B 或限制并发，不允许为获得表情而延迟开口。

## 与多 Agent 的关系

本地表现模型是应用内部推理服务，不注册为外部 Agent，也不参与 ConversationLedger
和 ResponseCommitter。目标多 Agent 范围收敛为：

- 同步 `reply` Agent：只生成文本 segment；不同 Turn 可以分派给不同 Agent 并行计算；
- 异步 `context-maintenance` Agent：在回复提交后提出摘要、长期记忆等 Context patch；
- 本地 `LocalPerformancePlanner`：对 sealed 文本生成表情和已有 Live2D 动作建议。

这样外部 Agent 端只需要实现对话语义与异步上下文维护，表演适配始终由掌握真实角色资产
能力的 DesktopChar 本地完成。
