# DesktopChar 表现模型 Provider 接入指南

本文面向实现或接入本地表现模型 Provider 的开发者。目标是让 Qwen3.5、其他
OpenAI-compatible 模型服务或后续自定义推理后端，通过相同的
`PerformanceInferencePort` 为 DesktopChar 返回表情和已有 Live2D 动作建议，不在
AvatarRuntime 或 Renderer 中增加模型名称特判。

当前固定领域契约为：

```text
Contract: desktop-char.performance-planning.v1
Current adapter: openai-compatible-chat
Transport: loopback HTTP
Required endpoint: POST /v1/chat/completions
Lifecycle implemented now: external
Response: one strict emotion/actions JSON object
```

表现模型接入不是 MCP。它只有“输入一个已经 sealed 的回复段，返回一个短结构化建议”
这一项数据能力，不负责工具发现、对话生成、音频流或角色控制。

## 1. 职责边界

完整调用链为：

```text
AvatarRuntime
  -> performance.infer Effect
  -> PerformanceRuntimeEffectHandler
  -> PerformanceInferencePort
  -> OpenAiCompatiblePerformanceAdapter
  -> Performance Model Provider
  -> LocalPerformanceSuggestion
  -> Runtime identity / capability / policy validation
  -> PerformanceTimeline
  -> semantic emotion / allowed action
```

各模块职责：

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| AvatarRuntime | 请求 identity、generation、segment revision、最终 cue 和呈现顺序 | Provider 协议、进程与模型实现 |
| PerformanceInferenceAdapter | HTTP 映射、deadline、取消、响应解析和协议错误分类 | 启动脚本、Live2D 资产编号和 Avatar 状态 |
| Performance Provider | 根据请求文本和能力目录返回语义建议 | 回复文本生成、动作执行、播放时钟和角色状态 |
| BehaviorPolicy | 置信度、白名单、动作数量和可执行时点 | 模型推理与进程管理 |
| CharacterProfile | 语义 emotion 到 Live2D expression 的角色级映射 | 模型 prompt 和请求调度 |
| Renderer | 执行 Runtime 下发的 expression/motion 命令 | 选择 emotion/action |

Provider 返回 `happy`、`nod` 等动态白名单 ID，不返回 `exp_02`、motion group/index 或
Live2D 参数。语义 ID 到具体资产的映射始终留在角色 sidecar 和 Renderer Adapter。

## 2. 当前生命周期

当前 `performanceInference.lifecycle` 只实现 `external`。

`external` 表示 Provider 进程由用户、启动脚本、系统服务、容器或远端 GPU 主机拥有。
DesktopChar：

- 不执行 Provider 启动程序；
- 不持有或结束 Provider 进程；
- 只在需要规划表现时调用已经存在的 endpoint；
- 配置变化或停用时取消自己的 in-flight 请求；
- Provider 不可用时按配置进入规则回退；
- 应用退出时不关闭 Provider。

右键菜单“表情动作推理（外部）”只修改当前运行期 Adapter 开关，不启动 Qwen 服务，
也不写回用户 JSON。

`managed` 是后续 Supervisor 目标，目前没有配置和运行时实现。Provider 接入不得假设
DesktopChar 已经能够自动启动模型服务，也不得把启动逻辑放进
`OpenAiCompatiblePerformanceAdapter`。

## 3. DesktopChar 配置

当前表现模型配置直接位于 `desktop-char.config.json`：

```json
{
  "performanceInference": {
    "enabled": true,
    "lifecycle": "external",
    "provider": "qwen35-transformers",
    "baseUrl": "http://127.0.0.1:18090/v1",
    "timeoutMs": 5000,
    "maxOutputTokens": 256,
    "temperature": 0.1,
    "fallbackToRules": true
  }
}
```

字段规则：

| 字段 | 规则 |
| --- | --- |
| `enabled` | 应用启动后的持久启用状态 |
| `lifecycle` | 当前固定为 `external` |
| `provider` | 必需；写入日志和标准化建议的稳定实现标识 |
| `baseUrl` | 必需；当前应用配置只接受 loopback HTTP `/v1` 根地址 |
| `model` | 可选；Provider 要求 OpenAI `model` 字段时填写，领域层视为 opaque 字符串 |
| `timeoutMs` | 必须为正数；覆盖一次完整 Chat Completions 请求 |
| `maxOutputTokens` | 必须为正整数；只应容纳短 JSON |
| `temperature` | `0` 到 `2` |
| `fallbackToRules` | Provider 失败时是否使用确定性规则 |

配置文件支持热重载。新 revision 会取消旧 Adapter 的 in-flight 请求，后续 plan 使用
新 endpoint/参数；旧 generation 或旧 segment revision 的迟到结果不能修改当前表演。

当前 loopback 限制是应用安全边界。Provider 在另一台 GPU 主机时，应通过 SSH/VPN
端口映射成 DesktopChar 本机的 loopback endpoint，而不是直接暴露无鉴权推理端口。

## 4. Provider HTTP 接口

当前 Adapter 只要求 OpenAI-compatible Chat Completions：

```http
POST {baseUrl}/chat/completions
Content-Type: application/json; charset=utf-8
```

请求体结构：

```json
{
  "model": "optional-provider-model-id",
  "messages": [
    {
      "role": "system",
      "content": "DesktopChar generated performance-planning instructions"
    },
    {
      "role": "user",
      "content": "{\"text\":\"...\",\"persona\":{},\"scene\":{},\"avatar\":{},\"emotions\":[],\"actionCatalog\":[]}"
    }
  ],
  "max_tokens": 256,
  "temperature": 0.1,
  "stream": false
}
```

约束：

- `model` 只有配置显式提供时才发送；
- `stream` 当前固定为 `false`，表现结果很短，不建立增量 cue；
- Provider 必须接受 UTF-8 中文文本；
- Provider 应关闭 thinking/reasoning，或确保最终 `message.content` 只包含目标 JSON；
- HTTP 非 2xx 响应应提供简短诊断正文；
- Client 取消请求或断开连接时，Provider 应尽快终止对应推理；
- 当前不要求 `/health` 或 `/models` 才能被 DesktopChar 调用；它们可供部署诊断使用，
  但不能替代真实 Chat Completions 验收。

OpenAI-compatible 最小响应：

```json
{
  "choices": [
    {
      "message": {
        "content": "{\"emotion\":null,\"actions\":[]}"
      }
    }
  ]
}
```

Adapter 只读取 `choices[0].message.content`。该字段必须是非空字符串。

## 5. 输入语义

Provider 在 user message 中收到以下 JSON 投影：

```json
{
  "text": "已经由 reply Agent 写好的完整段落",
  "persona": {
    "id": "mao",
    "styleTags": ["friendly"]
  },
  "scene": {
    "id": "desktop-default",
    "modeTags": ["desktop", "foreground"]
  },
  "avatar": {
    "state": "thinking",
    "currentEmotion": "neutral"
  },
  "emotions": ["neutral", "happy"],
  "actionCatalog": [
    {
      "actionId": "nod",
      "allowedAnchors": ["segment-start"]
    }
  ]
}
```

字段含义：

| 字段 | Provider 使用方式 |
| --- | --- |
| `text` | 只分析表现语义，不改写、续写或总结 |
| `persona` | 提供角色风格的只读投影，不是完整系统提示词 |
| `scene` | 提供当前场景和模式标签 |
| `avatar` | 提供请求时角色状态与当前语义 emotion |
| `emotions` | 本次唯一允许返回的 emotion ID |
| `actionCatalog` | 本次唯一允许返回的 action ID 和 anchor |

能力目录按当前 CharacterProfile、Renderer 能力和 Runtime policy 动态生成。Provider
不得缓存某个角色的固定动作列表，也不得发明、翻译或改写 ID。

`requestId`、`planId`、`segmentId`、`segmentRevision` 和 `generation` 不发送给模型。
它们由 Adapter/Runtime 在本地保留，并在标准化结果上恢复，用于拒绝错段和迟到结果。

## 6. 输出契约

Provider 的 `message.content` 应只包含一个 JSON 对象：

```json
{
  "emotion": {
    "emotion": "happy",
    "intensity": 0.75,
    "confidence": 0.9,
    "anchor": "segment-start"
  },
  "actions": [
    {
      "actionId": "nod",
      "confidence": 0.8,
      "anchor": "segment-start"
    }
  ]
}
```

没有合适表情或动作时：

```json
{
  "emotion": null,
  "actions": []
}
```

根对象规则：

- 只能包含 `emotion` 和 `actions`；
- `actions` 必须存在且为数组；
- 禁止附加解释、推理过程、角色台词或资产编号；
- Adapter 兼容外层 Markdown JSON fence，但 Provider 不应依赖该兼容路径。

### 6.1 emotion

`emotion` 可以是 `null`，否则必须满足：

| 字段 | 规则 |
| --- | --- |
| `emotion` | 必须来自请求的 `emotions` |
| `intensity` | `0` 到 `1` 的有限数字 |
| `confidence` | `0` 到 `1` 的有限数字 |
| `anchor` | 当前固定为 `segment-start` |

emotion 对象不能包含其他字段。

### 6.2 actions

`actions` 当前最多返回两项，并且不能超过请求中动作描述符的数量。每项必须满足：

| 字段 | 规则 |
| --- | --- |
| `actionId` | 必须来自 `actionCatalog`，同一响应中不能重复 |
| `confidence` | `0` 到 `1` 的有限数字 |
| `anchor` | 必须包含在该 action 的 `allowedAnchors` 中 |
| `clauseIndex` | 仅 `after-clause` 使用，必须是非负整数 |

当前 DesktopChar 实际向表现模型开放的动作 anchor 只有 `segment-start`。
`after-clause` 和 `segment-end` 保留在领域契约中，待文本—播放同步点接入后再开放。

## 7. 本地二次校验与应用策略

Provider 返回合法 JSON 不等于建议一定执行。DesktopChar 还会依次检查：

1. HTTP 与 Chat Completions 响应结构；
2. 根对象及所有子对象没有未知字段；
3. emotion/action/anchor 属于本次动态白名单；
4. intensity/confidence 数值范围；
5. request identity、generation 和 segment revision 仍然有效；
6. 原计划对应字段仍允许模型补全；
7. confidence 达到 Runtime policy 阈值；
8. action 数量符合当前角色策略；
9. 当前 Timeline 尚未错过对应 cue。

当前默认 `minPerformanceConfidence` 为 `0.35`，每个 segment 最多正式采用一个动作。
Provider 应把 `confidence` 作为“该表现确实适合当前文本”的置信度，而不是模型生成概率。

显式计划字段拥有最高优先级：

- segment 已显式提供 emotion 时，模型不能替换；
- segment 已显式提供 actions 时，模型不能替换；
- 显式空动作数组表示“不要自动动作”，不会发起该动作槽的推理；
- 模型结果迟到时只允许补入尚未触发的 cue，不重放旧 cue。

## 8. 错误、取消与降级

Adapter 使用以下稳定错误分类：

| 错误 | 场景 |
| --- | --- |
| `performance-http-error` | Provider 返回非 2xx |
| `performance-timeout` | 超过配置 deadline |
| `performance-provider-failure` | fetch、网络或 Provider 连接失败 |
| `performance-invalid-response` | Chat Completions 或表现 JSON 不符合契约 |
| `performance-aborted` | plan 中断、配置切换或应用取消 |
| `performance-contract-mismatch` | 领域契约版本不支持 |
| `performance-invalid-request` | Runtime 生成的请求 envelope 非法 |

`fallbackToRules=true` 时，可恢复的 Provider 错误会转入确定性规则；日志中
`request.completed source:"rules"` 不代表 Provider 接入成功。契约错误和本地非法
请求不能被静默隐藏。

Provider 恢复在线后只处理新请求，不补发或重演已经开始/完成的 segment。

## 9. 新 Provider 接入步骤

### 9.1 OpenAI-compatible Provider

如果新模型服务已经实现 Chat Completions：

1. 保证 `POST /v1/chat/completions` 接受本文请求；
2. 关闭 reasoning，稳定返回单个 JSON 对象；
3. 使用 DesktopChar 动态提供的 emotion/action ID；
4. 先以独立进程启动 Provider；
5. 在 `desktop-char.config.json` 设置 endpoint 和可选 model；
6. 运行 Adapter 诊断；
7. 提交一个没有显式 emotion/actions 的 segment；
8. 确认日志为 `request.completed source:"model"`；
9. 验证中断、超时、非法 JSON 和 Provider 离线降级；
10. 不修改 AvatarRuntime、CharacterProfile schema 或 Renderer。

同为 OpenAI-compatible 的 Qwen、vLLM、SGLang、llama.cpp 等服务只需更换配置和服务
启动方式，不应复制 Adapter。

### 9.2 非 OpenAI-compatible Provider

如果服务使用自定义 HTTP、gRPC 或进程内分类器：

1. 在 `packages/performance-inference` 外围新增 Adapter；
2. 实现同一个 `PerformanceInferencePort`；
3. 将 Provider 输入映射为 `PerformancePlanningRequest` 的语义；
4. 返回标准 `LocalPerformanceSuggestion`；
5. 保留 request/segment revision 和 AbortSignal；
6. 复用相同的 Runtime identity、白名单和 BehaviorPolicy；
7. 为协议映射、非法响应、超时和取消补齐 Adapter 测试。

禁止在领域层增加 `if (provider === "...")`，也禁止让 Provider 直接派发
`renderer.set-expression` 或 `renderer.play-motion`。

## 10. 参考实现

仓库中的首个参考实现：

- `performance-model-service/start.ps1`：Transformers 前台服务入口；
- `performance-model-service/bootstrap.ps1`：隔离环境和权重准备；
- `performance-model-service/smoke-test.ps1`：真实 Chat Completions 冒烟；
- `packages/performance-inference/src/openai-compatible.ts`：标准 Adapter；
- `packages/performance-inference/src/runtime-effect-handler.ts`：Effect/取消桥；
- `packages/performance-inference/src/fallback.ts`：可恢复错误降级；
- `packages/performance-inference/test/adapter.test.ts`：协议和错误分类测试；
- `scripts/performance-diagnostic.ts`：使用桌面同一 Adapter 的契约诊断。

Qwen3.5-2B 是参考 Provider，不是协议名称。替换模型不能改变
`desktop-char.performance-planning.v1` 的领域语义。

## 11. 接入验证

先确认 Provider 自身 endpoint：

```powershell
Invoke-RestMethod http://127.0.0.1:18090/v1/models
```

`/v1/models` 只用于诊断；服务不实现时，可以直接测试 Chat Completions。

使用仓库参考服务时：

```powershell
npm run performance:smoke
```

使用 DesktopChar Adapter：

```powershell
$env:DESKTOP_CHAR_PERFORMANCE_BASE_URL = "http://127.0.0.1:18090/v1"
npm run diagnose:performance
Remove-Item Env:\DESKTOP_CHAR_PERFORMANCE_BASE_URL
```

前台验收时，启动 `npm run desktop`，提交一个没有显式 emotion/actions 的 plan，并检查：

```text
[performance] ... "event":"request.started"
[performance] ... "event":"request.completed" ... "source":"model"
[performance] ... "event":"expression.applied"
```

仅右键执行“测试 Happy 表情资源”不会请求 Provider；它只验证 CharacterProfile 到
Live2D expression 的链路。

## 12. 验收清单

新 Provider 接入完成必须满足：

1. Chat Completions 接受 UTF-8 文本并在 deadline 内返回；
2. `choices[0].message.content` 是非空字符串；
3. 内容是只有 `emotion/actions` 的单个 JSON 对象；
4. Provider 不返回能力目录以外的 ID；
5. 空建议稳定返回 `emotion:null` 和 `actions:[]`；
6. intensity/confidence/anchor 满足严格契约；
7. DesktopChar Adapter 诊断输出 `source:"model"`；
8. segment 显式 cue 不会被模型替换；
9. 中断和配置重载能取消 in-flight 请求；
10. 超时、HTTP 错误和非法 JSON 被正确分类；
11. `fallbackToRules=true` 时角色继续工作且日志明确标识回退；
12. Provider 恢复后不重放旧 segment；
13. 实际建议能通过 CharacterProfile 映射并在前台呈现；
14. 与 TTS 同时运行时不会明显恶化语音首包和 Live2D 帧率；
15. 实现中没有模型名称特判或领域层 Provider 依赖。

仓库侧回归命令：

```powershell
node --experimental-strip-types --test packages/performance-inference/test/*.test.ts
node --experimental-strip-types --test packages/avatar-runtime/test/*.test.ts
npm run typecheck
npm run test:smoke
```

完整的模块边界、未来 managed Supervisor 和多模型迁移策略见
`docs/performance-model-integration.md`。
