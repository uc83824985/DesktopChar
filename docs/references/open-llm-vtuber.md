# Open-LLM-VTuber 模块化参考

## 参考范围

本文基于以下浅克隆提交的代码阅读结果：

- `Open-LLM-VTuber`：`992309c`
- `Open-LLM-VTuber-Web`：`d176e7d`

Open-LLM-VTuber v1 是完整的语音交互 AI Companion 平台，覆盖 LLM、ASR、TTS、视觉输入、Live2D、会话历史、多人会话、MCP、Web 和 Electron 客户端。DesktopChar 只参考其中与桌面角色、表演意图、音频播放和桌宠窗口相关的模块，不把它作为 fork、源码依赖或首版功能范围。

项目已声明 v2 将全面重写，因此本文记录的是经过产品使用验证的工作流，而不是应当保持兼容的上游架构。

## 相关运行链路

```text
Web/Electron client
        |
        v
WebSocketHandler
        |
        v
ServiceContext: ASR / Agent / TTS / Live2D config
        |
        v
LLM token stream
        |
        v
SentenceDivider -> ActionsExtractor -> TTS Filter
        |
        v
SentenceOutput(display text, TTS text, actions)
        |
        v
TTSTaskManager: parallel synthesis, ordered delivery
        |
        v
audio payload(audio, expression, display text)
        |
        v
frontend audio task queue
        |
        v
expression + Talk motion + lip sync
        |
        v
frontend-playback-complete
```

该链路验证了 DesktopChar 的三个基础边界：上游负责给出表演意图，播放器负责提供真实时间，Avatar Runtime 负责把意图平滑地落实到模型参数。

## 可借鉴的模块化模式

### 句子级输出模型

上游 token 流先被切成句子，再形成包含展示文本、TTS 文本和动作信息的 `SentenceOutput`。展示文本与朗读文本可以不同，例如思考内容可以显示但不朗读。

DesktopChar 应保留这种分离，并使用 `PerformanceSegment` 表达：

```ts
interface PerformanceSegment {
  text: string;
  emotion?: Emotion;
  intensity?: number;
  action?: AvatarAction;
  beat?: SemanticBeat;
}
```

不同点是 DesktopChar 不允许上游直接输出 Live2D expression 索引，而由角色配置和 Avatar Planner 完成领域情绪到模型资源的映射。

### 并行合成、顺序播放

`TTSTaskManager` 为每个句子分配序号，允许 TTS 并行生成，但只有连续序号就绪时才向前端发送。无语音内容也会发送 silent payload，以保持字幕和表情事件顺序。

DesktopChar 将这一模式放在应用编排或 `tts-mcp-adapter` 上层，使用稳定的 segment ID 和 sequence，不放入 Renderer：

```ts
interface SynthesizedSegment {
  segmentId: string;
  sequence: number;
  audio: AudioSource | null;
  performance: PerformanceSegment;
}
```

### 播放完成闭环

后端的 `backend-synth-complete` 只表示合成结束。它随后等待前端的 `frontend-playback-complete`，收到后才结束 conversation chain。

DesktopChar 必须区分以下生命周期：

```text
synthesis-complete
playback-started
playback-progress
playback-paused
playback-resumed
playback-interrupted
playback-completed
```

Timeline 只跟随 `PlaybackClock`，不得用 TTS 请求完成时间、下载完成时间或音频 chunk 到达时间代替播放位置。

### 角色级表情映射

上游通过 `[emotion]` 标签表达情绪，后端根据 `model_dict.json` 中的 `emotionMap` 转换为角色 expression。

DesktopChar 保留“领域情绪与模型资源分离”的思想，但将映射收敛到 `config`：

```text
Emotion -> CharacterConfig -> expression/motion resource
```

Avatar Planner 还需补充白名单、强度裁剪、冷却时间和默认状态，避免上游直接驱动模型。

### 桌宠窗口状态

Electron 客户端把窗口行为留在主进程，支持普通窗口和桌宠模式。桌宠模式会：

- 覆盖多显示器联合区域；
- 使用透明、置顶、跳过任务栏的无边框窗口；
- 默认开启鼠标穿透；
- 在鼠标进入可交互组件时临时关闭穿透；
- 分平台处理焦点、工作区和 `setIgnoreMouseEvents`。

DesktopChar 的 `apps/desktop/main` 可参考状态切换流程，但窗口策略应通过 `DesktopShellPort` 隔离。首版优先评估紧凑角色窗口；全虚拟桌面透明窗口作为可替换实现，避免过早承担多屏合成和焦点管理复杂度。

## 与 DesktopChar 的模块映射

| 上游实现 | DesktopChar 模块 | 采用方式 |
| --- | --- | --- |
| `Live2dModel.emo_map` | `config` | 保留角色级 emotion-expression 映射 |
| `SentenceOutput` / `Actions` | `contracts` | 扩展为带强度、动作和语义节拍的 segment |
| `TTSTaskManager` | 应用编排、`tts-mcp-adapter` | 保留并行合成和有序提交 |
| audio WebSocket payload | `contracts`、`transport` | 拆分音频、表演计划和播放事件 |
| frontend audio task queue | `audio-runtime` | 保留有序播放，移出 React hook |
| WAV lip sync handler | `audio-runtime`、Renderer adapter | 通过公共接口封装 |
| expression hook | `avatar-runtime` | 改由 Timeline 调度和 Mixer 合成 |
| random `Talk` motion | `avatar-runtime` | 作为 Base/Gesture 能力，不与口型绑定 |
| Electron `WindowManager` | `apps/desktop/main` | 参考窗口状态，不复制安全配置 |
| `WebSocketHandler` | `transport` | 收敛为最小命令和事件协议 |
| `ServiceContext` | composition root | 不引入完整 provider 容器 |

## 不应照搬的设计

### UI 直接访问渲染器私有字段

客户端直接读取 `_wavFileHandler` 等 Live2D 私有成员，导致 React hook 与特定 SDK 实现耦合。DesktopChar 的 UI 只能依赖 `AvatarControlPort`，第三方兼容代码必须封装在 `live2d-renderer` 或口型适配器内部。

### 音量协议与实际实现不一致

后端会生成默认 20ms 间隔的 RMS `volumes`，前端接收 `volumes` 和 `slice_length`，但实际口型由 WAV handler 重新解析音频驱动。DesktopChar 必须明确唯一数据所有者：优先使用 TTS viseme；否则基于真实播放音频生成 amplitude envelope，二者都以播放时钟采样。

### 表情、动作和口型混在播放 Hook

客户端播放音频时同时设置 expression、随机播放 `Talk` motion 并启动口型。这样难以支持动作优先级、句中 cue、淡入淡出和安全中断。DesktopChar 将其拆为：

```text
audio-runtime: playback clock, audio lifecycle
avatar-runtime: planner, timeline, state machine, mixer
live2d-renderer: model API adapter
```

### 过宽的 ServiceContext

`ServiceContext` 同时聚合 ASR、TTS、Agent、Live2D、翻译和 MCP。它适合完整 Companion 产品，但对独立桌面角色首版过重。DesktopChar composition root 只装配当前闭环所需端口，不把 provider 容器传播到领域层。

### Electron 安全配置

参考客户端虽然启用了 `contextIsolation`，但同时关闭 sandbox、启用 Node integration，并向 renderer 暴露较通用的 IPC 能力。DesktopChar 应坚持：

```text
sandbox: true
contextIsolation: true
nodeIntegration: false
preload only exposes allow-listed domain APIs
```

## 中断要求

参考实现会同时取消后端 conversation task、清空前端播放队列并停止当前音频。DesktopChar 应把中断定义为跨模块事务：

```text
停止接收新 segment
-> 取消未完成 TTS
-> 清空待播放音频
-> 中断当前播放器
-> 取消 Timeline
-> 嘴型归零
-> 动作安全收尾
-> 回落 neutral/idle
```

`audio.pause()` 不能代表中断完成。中断操作应可重复调用，并最终收敛到同一稳定状态。

## 开发约束总结

1. 保留句子/segment 级表演数据，不逐 token 驱动模型。
2. TTS 可以并行生成，但音频、字幕和表演 cue 必须按 sequence 提交。
3. 表演 Timeline 只绑定真实播放时钟。
4. Renderer 不理解自然语言、TTS provider 或业务会话。
5. 角色 emotion 映射属于配置，表达频率和强度校验属于 Avatar Planner。
6. Mouth、Expression、Gesture、Gaze、Base 独立计算，Mouth 最后写入。
7. UI 不访问 Live2D/Pixi 私有字段。
8. 桌面窗口策略与 Avatar Runtime 解耦。
9. 首版不引入完整 ASR、Agent、历史、多客户端或 MCP provider 容器。
10. 参考仓库不进入 DesktopChar 的构建、打包和运行时依赖。
