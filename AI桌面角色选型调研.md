# AI 桌面角色选型调研

调研日期：2026-07-18

## 1. 需求边界

当前目标是第一版二次元风格 AI 桌面角色。即使后续考虑 3D，也优先动漫风格，不追求拟真人或复杂舞蹈。已有实时 TTS MCP 服务，因此本轮重点不评估完整语音链路，而是确认桌面壳、Live2D 渲染、口型同步、表情与简单姿态动作的实现参考。

本轮仓库仅作实现原理、架构边界、API 设计、状态机与工作流参考，不作为 fork 或二次开发依赖。

## 2. 高参考价值仓库

| 仓库 | 方向 | README 快速确认 | 参考价值 | 风险/注意点 |
| --- | --- | --- | --- | --- |
| [Open-LLM-VTuber/Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) | 完整 AI VTuber/桌宠后端与产品形态 | 支持实时语音、Live2D、跨平台、Web/桌面客户端、桌宠模式；桌宠模式包含透明背景、置顶、鼠标穿透；后端支持表情映射、ASR/LLM/TTS 多 provider。 | 最适合作为整体产品工作流参考：模块边界、角色配置、前后端协议、桌宠模式、表情驱动链路。 | 项目处于 v2 重写规划期，v1 可参考但不宜按其结构照搬；功能面过宽。 |
| [Open-LLM-VTuber/Open-LLM-VTuber-Web](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber-Web) | Electron + React + TypeScript 前端/桌面壳 | README 明确是 Open-LLM-VTuber 的 Web/Electron 前端，支持 Windows/macOS/Linux 构建。 | 适合参考 Electron 桌面客户端组织方式、前端构建、跨平台打包、与后端服务通信。 | README 信息偏基础；桌宠细节更多要结合主仓库或源码看。 |
| [RTGS2017/NagaAgent](https://github.com/RTGS2017/NagaAgent) | 桌面助手 + Live2D 动画状态机 + TTS 驱动口型 | README 描述使用 pixi-live2d-display + PixiJS WebGL；TTS 期间 60FPS 驱动 Live2D 嘴形；有体态、动作、表情、追踪四通道动画系统，并说明合并顺序。 | 对“自然表情 + 简单姿势动作”价值很高。可重点参考表情/动作/口型/鼠标追踪的分层状态机，而不是复制业务功能。 | 功能较重，包含登录、市场、MCP、记忆、控制等大量非首版必要能力；需剥离形象控制层思路。 |
| [Panzer-Jack/easy-live2d](https://github.com/Panzer-Jack/easy-live2d) | 轻量 Live2D Web SDK 封装 | README 明确把 Live2D 模型封装为 Pixi Sprite，提供加载、命中检测、拖拽、动作、表情、语音播放、唇形同步等 API；示例包含 `setExpression`、`playVoice`、参数控制。 | 适合作为首版渲染层 API 参考：加载模型、设置表情、播放动作、驱动嘴形、命中/拖拽。 | README 的 license 描述有页面展示差异：正文写代码 MPL-2.0，侧栏显示 MIT；如果后续实际依赖必须复核 LICENSE。Live2D Cubism Core 仍需按官方许可单独处理。 |
| [Untitled-Story/untitled-pixi-live2d-engine](https://github.com/Untitled-Story/untitled-pixi-live2d-engine) | PixiJS v8 Live2D 渲染引擎 | README 显示支持 Cubism 2/3/4/5、PixiJS v8、实时 lip sync、并行动作、末帧冻结、鼠标追踪、命中检测、严格 TS 类型。 | 技术选型上很值得评估，尤其适合新项目直接面向 PixiJS v8、Cubism 5、并行动作与简单姿态冻结。 | 星标较少、生态成熟度低于 pixi-live2d-display；需要做小样验证稳定性。 |
| [guansss/pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) | 经典 PixiJS Live2D 显示插件 | README 表示支持多类 Live2D 模型，包含 Cubism 2.1 与 Cubism 3/4 方案；基础示例包含模型加载、舞台添加、坐标缩放、命中触发动作。 | 成熟度和社区引用价值高。适合作为兼容性、老项目实现、Live2D 基础控制的基准参考。 | 最新 release 停在 2023-12 的 beta；PixiJS 版本较旧，不一定适合作为新项目最终依赖。 |
| [Live2D/CubismWebSamples](https://github.com/Live2D/CubismWebSamples) | 官方 Web SDK 示例 | README 说明这是展示 Live2D Cubism Editor 输出模型的官方示例，配合 Cubism Web Framework/Core 使用，兼容 Cubism 5.3；仓库不管理 Cubism Core，需要从官方 SDK 获取。 | 必须作为官方边界参考：SDK 初始化、模型资源结构、许可、Web 平台兼容性。 | 示例偏底层，不提供 AI 桌宠产品架构；实现效率不如上层 Pixi 封装。 |

## 3. 中高参考价值仓库

| 仓库 | 方向 | README 快速确认 | 参考价值 | 风险/注意点 |
| --- | --- | --- | --- | --- |
| [moeru-ai/airi](https://github.com/moeru-ai/airi) | 大型自托管 AI companion | README/About 显示支持 Web/macOS/Windows、实时语音、Live2D、VRM、记忆、游戏/平台集成；路线图中包含 Live2D/VRM 控制、自动眨眼、看向、眼动。 | 很适合看长期架构：多端应用、Live2D/VRM 并存、语音 provider 抽象、模块化包组织。 | 项目很大，首版照着做会过重；作为战略参考，不作为 MVP 主路径。 |
| [LiiLk/Local-AI-Companion](https://github.com/LiiLk/Local-AI-Companion) | 本地优先桌面 AI companion | README 明确稳定链路为 Mic -> VAD -> Faster-Whisper -> LLM -> Kokoro TTS -> RVC -> Audio，包含 Live2D desktop companion、WebSocket backend、运行生命周期与测试覆盖。 | 适合参考“语音服务/后端/前端 shell”的边界设计。由于我们已有 TTS MCP，可重点看其 WebSocket 与 runtime ownership，而非复用 TTS 链路。 | 星标很少，社区验证有限；Windows-first，与跨平台目标需拆开看。 |
| [meet447/MeuxCompanion](https://github.com/meet447/MeuxCompanion) | Tauri 2 + Live2D/VRM AI companion | README 显示本地优先，Tauri 2，Live2D 与 VRM，表达感知流式输出，分句并行 TTS，语音输入，透明 mini widget。 | 若倾向 Tauri，参考价值较高。特别适合看 emotion tag 流式解析、每句情绪反应、Live2D/VRM 双形象抽象。 | 仍是完整 companion 应用，不应直接按其功能范围扩张首版。 |
| [Tosuke-sama/DesktopFriends](https://github.com/Tosuke-sama/DesktopFriends) | Live2D 桌宠 + Agent 工具调用 + 多端 | README 显示 Vue/TypeScript/Tauri/Capacitor/Live2D，支持 LLM 驱动表达与动作、Live2D 模型上传、多角色、macOS 透明窗口与 click-through。 | 可参考 Agent 如何把表情/动作暴露为 tool、Live2D 模型上传与多角色管理、桌面透明窗口交互。 | 桌面端 README 标注偏 macOS，Windows/Linux 仍在计划；TTS/STT 也在计划中，不适合作为语音口型主参考。 |
| [funnycups/petto](https://github.com/funnycups/petto) | Live2D 桌面助手/桌宠 | README 显示支持上下文问候、流式/Whisper 语音识别、TTS、动作触发、表情管理；v3 默认 Kage 模式，并保留 Live2DViewerEX 兼容模式。 | 对桌宠产品细节有参考价值：Kage/Live2DViewerEX 外部驱动模式、动作列表、表情管理、语音识别与唤醒。 | GPL-3.0-or-later，不能复制代码到非 GPL 项目；外部运行时模式不一定适合作为内置渲染首版。 |
| [kiskaserver/interactive_assistent](https://github.com/kiskaserver/interactive_assistent) | Tauri 2 + React/PixiJS/Live2D 桌面助手 | README 显示 Tauri 2、Live2D Cubism 2/3/4/5、idle blinking、眼球追踪、tap motion、情绪驱动表情、TTS 口型同步、截图/视觉/RAG/本地云混合路由。 | 对首版形象控制清单很有价值：Live2DCanvas、avatarState、emotion、lipsync、透明桌面壳、设置与资源目录。 | 星标极少，代码成熟度需验证；功能范围偏大，许多 AI/自动化能力不属于形象首版。 |
| [myths-labs/prometheus-avatar](https://github.com/myths-labs/prometheus-avatar) | Live2D/3D avatar SDK + MCP | README 显示以 SDK 方式驱动 Live2D 与 3D avatar，包含 lip-sync、emotion expressions、real-time voice、多语言 TTS、MCP Server；架构中有 renderer、tts、lip-sync、emotion、types。 | 适合参考面向外部 AI Agent/MCP 的 avatar 控制 API 设计，尤其与现有 TTS MCP 对接思路接近。 | 星标较少，产品/市场化描述较多；需验证 SDK 实际深度与维护稳定性。 |

## 4. 首版建议参考组合

推荐首版仍以 Live2D 为主，而不是 VRM/MMD/Spine/Rive。原因是当前需求核心是二次元形象、自然表情、口型同步和简单姿态动作，Live2D 在资产供给、面部表现、Web 渲染、桌宠集成上最贴合，且不需要复杂骨骼舞蹈链路。

建议组合：

```text
桌面壳参考：Open-LLM-VTuber-Web / MeuxCompanion / interactive_assistent
Live2D 渲染参考：easy-live2d / untitled-pixi-live2d-engine / pixi-live2d-display
动画状态机参考：NagaAgent 的 State / Action / Emotion / Tracking 分层
官方 SDK 与许可边界：Live2D/CubismWebSamples
长期产品架构参考：Open-LLM-VTuber / AIRI
MCP/外部控制接口参考：prometheus-avatar
```

## 5. 表演驱动模块分工

当前核心设计结论是：LLM 负责给出“哪里该变”，TTS/播放器负责给出“什么时候变”，Avatar Runtime 负责“怎么平滑变”。口型、表情、姿势动作需要拆成不同控制层，避免把所有表现都塞进一个 Live2D motion 或一段 TTS 文本中。

### 5.1 模块职责

| 模块 | 核心职责 | 不应负责 |
| --- | --- | --- |
| LLM / Response Planner | 生成回复文本，并按语义片段标注情绪、强度、动作意图、动作大致位置。 | 不直接输出 Live2D 参数，不输出精确毫秒，不直接控制模型。 |
| Avatar Planner | 校验 LLM 标注，限制动作频率，合并过碎片段，降级过强表情，补默认状态。 | 不生成音频，不依赖具体渲染库。 |
| TTS MCP | 把文本生成音频流或音频文件；如果能力支持，返回字、词、音素或 viseme 时间戳。 | 不决定角色表情、动作和姿态。 |
| Player / Playback Clock | 提供真实播放时钟，发出开始、进度、暂停、恢复、中断、结束事件。 | 不使用 TTS 请求时间或音频 chunk 到达时间替代播放时间。 |
| Lip Sync | 基于实际播放音频的音量包络或 viseme 时间戳驱动嘴型。 | 不负责情绪、姿态和动作选择。 |
| Avatar Runtime | 调度表演时间线，处理表情淡入淡出、动作播放、优先级混合、中断回收和 idle 回落。 | 不理解自然语言，不生成语音。 |
| Live2D Renderer | 加载模型、播放 motion、设置 expression、写入参数、处理 hit test/拖拽/resize。 | 不绑定 LLM/TTS provider，不承载业务状态机。 |

### 5.2 句中变化建议

句中表情和动作变化建议用“语义节拍”驱动，而不是逐 token 驱动。LLM 可以输出短句级表演意图，TTS 只朗读纯文本，Avatar Runtime 根据播放器时间轴调度 cue。

推荐数据结构：

```json
{
  "segments": [
    {
      "text": "这里先别急，",
      "emotion": "calm",
      "intensity": 0.35
    },
    {
      "text": "真正的问题在后半段。",
      "emotion": "serious",
      "intensity": 0.65,
      "action": "look_down",
      "beat": "middle"
    },
    {
      "text": "但解决方式其实很简单。",
      "emotion": "happy",
      "intensity": 0.55,
      "action": "nod",
      "beat": "end"
    }
  ]
}
```

调度规则：

1. 每个短句最多一个主表情，明显表情变化间隔建议不低于 2 秒。
2. 动作落在语义重音处，例如转折、确认、否定、惊讶、提醒等位置。
3. 表情可比语音片段提前 100-250ms 进入，点头等动作可落在关键词后 100-400ms。
4. 嘴型始终跟播放器时钟或 viseme 时间戳，不跟表情 motion 绑定。
5. 回复结束后 600-1000ms 平滑回到 neutral/idle。

### 5.3 控制层优先级

建议把 Live2D 控制拆成以下层：

```text
Base Layer: 呼吸、眨眼、待机轻摆
Expression Layer: 情绪表情，低频变化，淡入淡出
Gesture Layer: 点头、摇头、低头、抬头、挥手等短动作
Gaze Layer: 看用户、看鼠标、思考时视线偏移
Mouth Layer: TTS 音频/viseme 驱动嘴型
```

运行时写入优先级：

```text
嘴型 > 明显动作 > 表情 > 视线 > idle
```

实际实现时，嘴型层应最后写入 `ParamMouthOpenY` 和可选 `ParamMouthForm`，避免动作 motion 覆盖说话口型。表情层与嘴型层要独立混合，否则 speaking 状态下会出现表情切换导致嘴型失效的问题。

### 5.4 首版可执行闭环

首版不需要复杂面捕或复杂骨骼动画，建议先形成以下闭环：

```text
LLM 输出 segments
Avatar Planner 做白名单、频率限制和强度修正
TTS MCP 合成每个 segment 的音频
Player 提供真实 playback clock
Timeline 按 segment 时间触发表情和动作 cue
Lip Sync 用音量包络或 viseme 驱动嘴型
Renderer 写入 Live2D 参数和 motion
```

这样可以支持句中表情/动作变化，同时保持模块边界稳定。后续升级 viseme、替换 TTS、替换 Live2D 渲染库，或增加 VRM 3D 角色时，不需要推翻整体结构。

## 6. 基础结论

第一版建议实现成“独立 Avatar Runtime + 桌面透明壳 + TTS MCP 输入适配”的结构，而不是从完整 AI companion 仓库克隆功能。

最小可行接口可以先收敛为：

```ts
setEmotion(emotion: "neutral" | "happy" | "sad" | "angry" | "surprised" | "thinking"): void
setState(state: "idle" | "listening" | "thinking" | "speaking"): void
playAction(action: "nod" | "shake" | "tap" | "greet"): Promise<void>
speak(audio: AudioSource, timing?: VisemeTiming[] | AmplitudeEnvelope): Promise<void>
lookAt(x: number, y: number): void
```

短期落地优先级：

1. 先用 Live2D + Pixi 渲染跑通透明窗口、模型加载、拖拽、点击区域、基础动作。
2. 接入已有实时 TTS MCP，把音频播放事件转成嘴形参数；若 TTS 能提供音素/viseme 时间戳则优先用时间戳，否则用音量包络驱动 `ParamMouthOpenY`。
3. 增加 Avatar Planner 和 Timeline，支持短句级情绪、动作 cue 与播放器时钟绑定。
4. 做简单状态机：idle、listening、thinking、speaking 四态；表情层与嘴形层独立混合，避免说话时覆盖表情。
5. 表情先采用 LLM 输出标签或后处理 emotion classifier，不做摄像头面捕；鼠标/窗口焦点只用于视线跟随和轻量动作。
6. 渲染库先做小样对比：`easy-live2d` 上手快，`untitled-pixi-live2d-engine` 更现代，`pixi-live2d-display` 作为成熟兼容基线。

当前基础选型结论：第一版主路线选择 Live2D；桌面壳在 Electron 与 Tauri 中二选一，若追求开发速度和 Web 生态兼容优先 Electron，若追求体积和系统集成优先 Tauri；Live2D 控制层必须自研一层薄 API，后续才能平滑替换渲染库或扩展 VRM。
