# 项目模块结构

## 设计结论

首版使用 Live2D，桌面侧先按 Electron 的进程模型划分，但领域包不依赖 Electron，因此后续切换 Tauri 时只需替换 `apps/desktop`。运行时的核心原则是：LLM/上游给出“哪里该变”，播放器给出“什么时候变”，Avatar Runtime 决定“怎么平滑变”。Runtime 是 Avatar 状态的唯一所有者；UI、播放器、TTS 和 Renderer 只能发送事实事件或执行 Runtime 下发的 Effect，不得直接修改状态。

```text
TTS MCP / Response Planner
           |
           v
  tts-mcp-adapter ----> contracts <---- config
           |                |
           v                v
     audio-runtime ---> avatar-runtime
        playback clock   planner / timeline / mixer
           |                |
           +-------+--------+
                   v
           live2d-renderer
                   |
                   v
         desktop renderer process
```

## 运行链路

1. 上游提交由若干 `PerformanceSegment` 组成的表演计划。
2. `tts-mcp-adapter` 仅把纯文本合成为 `AudioSource`，并保留可选 viseme 时间戳。
3. `audio-runtime` 播放音频，以真实播放位置发出 `PlaybackEvent`。
4. `avatar-runtime` 校验情绪和动作白名单，生成 cue，并按播放时钟推进 Timeline。
5. Mixer 依次合成 Base、Gaze、Expression、Gesture、Mouth；Mouth 最后写入。
6. `live2d-renderer` 把领域命令映射为具体 Pixi/Live2D API，不理解 LLM、TTS 或业务状态。
7. 中断时先停止播放器，再取消 Timeline，嘴型归零，最后平滑回到 neutral/idle。

模块职责、事件模型、Effect 边界和状态所有权详见 [Avatar Runtime 模块设计](avatar-runtime.md)。当前代码中的 `setState`、`setEmotion`、`playAction` 等公开直控接口属于待替换的早期骨架，不作为后续实现契约。

## 包依赖约束

```text
apps/desktop -> transport, config, avatar-runtime, audio-runtime, live2d-renderer
avatar-runtime -> contracts
audio-runtime -> contracts
live2d-renderer -> contracts
tts-mcp-adapter -> contracts
transport -> contracts
config -> contracts
```

- `contracts` 不依赖任何其他项目包。
- `avatar-runtime` 不导入 Pixi、Live2D SDK、Electron 或 MCP 客户端。
- Runtime 是 `AvatarSnapshot`、状态机、Timeline、动作队列和中断 generation 的唯一所有者。
- UI、播放器、TTS 和 Renderer 不得调用状态 setter；它们只向 Runtime 提交 `AvatarEvent`。
- Runtime reducer 只计算 `Snapshot + Effects`，由外围 effect runner 执行音频、TTS 和渲染副作用。
- `live2d-renderer` 不选择情绪，不调度音频，不保存会话业务状态。
- UI 不读取 `_wavFileHandler`、`internalModel` 等第三方私有字段；这些兼容细节只能留在适配器内部。
- 参考仓库不进入构建、打包和运行时依赖。

## 参考代码阅读结论

### Open-LLM-VTuber (`992309c`)

- `ServiceContext` 聚合 ASR、TTS、Agent、Live2D 与 MCP provider，工厂模式便于切换实现，但对本项目首版过重。
- conversation 层把文本、actions、音频、音量切片组成 WebSocket payload，证明“协议携带表演意图、前端负责播放”可行。
- 前端播放开始/完成会反馈后端，说明播放生命周期不能用 TTS 请求完成时间替代。
- 详细的模块映射、适用边界和落地约束见 [Open-LLM-VTuber 模块化参考](references/open-llm-vtuber.md)。

### Open-LLM-VTuber-Web (`d176e7d`)

- Electron 明确拆分 `main`、`preload`、`renderer`；窗口透明、置顶、鼠标穿透由主进程管理。
- WebSocket handler 负责协议分发，audio task queue 保证分句顺序，Live2D hook 负责模型表现。
- 当前实现会直接访问 Live2D 的 `_wavFileHandler` 等私有成员；本项目改为 `LipSyncSource` 与 `Live2DRenderer` 公共接口，避免 UI 与 SDK 版本绑定。

### NagaAgent (`3b84e9e`)

- `live2dController.ts` 把 state、action、emotion、tracking、mouth 分成独立通道，再在帧更新时合成，适合作为 Avatar Runtime 的直接思想来源。
- action queue、关键帧插值、表情淡入淡出、鼠标追踪均应留在运行时层。
- 其 talking 状态中的随机 viseme 只能作为无音频数据时的降级；首版优先使用真实音频包络或 TTS viseme 时间戳。

## 首版实施顺序

1. 完成 Electron 透明窗口和安全 preload 桥。
2. 在 `live2d-renderer` 中验证模型加载、resize、hit test 和参数写入。
3. 实现播放器时钟与音量包络口型，跑通 `speak()`。
4. 实现四态状态机和 expression/gesture/gaze/mouth 分层 Mixer。
5. 接入 segment Timeline、动作白名单、中断与 idle 回落。
