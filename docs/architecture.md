# 项目模块结构

## 设计结论

首版使用 Live2D，桌面侧先按 Electron 的进程模型划分，但领域包不依赖 Electron，因此后续切换 Tauri 时只需替换 `apps/desktop`。运行时的核心原则是：LLM/上游给出“哪里该变”，播放器给出“什么时候变”，Avatar Runtime 决定“怎么平滑变”。Runtime 是 Avatar 状态的唯一所有者；UI、播放器、TTS 和 Renderer 只能发送事实事件或执行 Runtime 下发的 Effect，不得直接修改状态。

```text
语音合成 MCP / Response Planner
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

Electron 壳层在领域链路之外：main 独占原生窗口位置、包围盒、置顶和鼠标穿透；preload 只提供受控 IPC；renderer 将点击转换为 Runtime Event，将拖动转换为窗口命令。透明悬浮窗口的交互取舍见 [透明桌面悬浮壳设计](desktop-shell.md)。

应用接入层同时包含语音合成 MCP Client（技术标识 TTS）与角色接入 MCP Server（技术标识 `characterMcp`）。Electron main 的服务控制器独占两端连接、配置 revision、热重载与重连状态；角色接入 MCP 和兼容 Agent HTTP 最终只向 renderer 发送相同的白名单 `PerformancePlan / interrupt` 命令。完整生命周期与工具见 [MCP 服务生命周期与角色接入接口](mcp-services.md)。

## 运行链路

1. 上游提交由若干 `PerformanceSegment` 组成的表演计划。
2. `tts-mcp-adapter` 把纯文本准备为流式优先的 `AudioSource`；MCP 返回流描述，音频字节由 HTTP 数据面增量传输。
3. `audio-runtime` 消费流或整段音频，以真实缓冲、播放位置、实时电平和播放生命周期发出 `PlaybackEvent`。
4. `avatar-runtime` 校验情绪和动作白名单，生成 cue，并按播放时钟推进 Timeline。
5. Mixer 依次合成 Base、Expression、Gesture、Gaze、Mouth；启用跟随时 Gaze 持续拥有头部/眼球跟随参数，Mouth 始终最后写入嘴部开合。
6. `live2d-renderer` 缓存最新完整 ParameterFrame，并在 Live2D `beforeModelUpdate` 应用，避免 motion、focus、physics 覆盖 Runtime 输出；它不理解 LLM、TTS 或业务状态。
7. 中断时先停止播放器，再取消 Timeline，嘴型归零，最后平滑回到 neutral/idle。

模块职责、事件模型、Effect 边界和状态所有权详见 [Avatar Runtime 模块设计](avatar-runtime.md)。当前代码中的 `setState`、`setEmotion`、`playAction` 等公开直控接口属于待替换的早期骨架，不作为后续实现契约。

当前 `audio-runtime` 已提供单声道 `pcm_s16le` 的 Web Audio 分片播放器，并使用先验铃声在前台核对“播放采样 -> level 事件 -> Runtime/Mixer -> Mao 参数”时点；验收细节见 [先验铃声流与口型时点验收](audio-lip-sync-acceptance.md)。

## Scene Engine 边界

可交互桌面场景采用通用 `SceneActor + Component + Slot + Relation + Behavior + RenderPart`，不在引擎层增加家具、物件或播放器等业务类型。Scene Runtime 独占场景状态，通过 generation 隔离旧事件，并将 Scene、Transaction 和 Fragment 作为原子变更提交；应用层负责声明内容、注册行为和选择 Scenario。

渲染侧使用 Color、Depth、Coverage/Picking 分离的 2.5D 描述：可拆资源通过 RenderPart 和 Render Band 表达稳定前后关系，难拆资源通过 box、ellipsoid、mesh、depth-map 等 proxy 参与深度合成。完整边界、约束和测试映射见 [Scene Engine 抽象设计](scene-engine.md)。

## 包依赖约束

```text
apps/desktop -> transport, config, avatar-runtime, audio-runtime, live2d-renderer
apps/desktop -> scene-runtime
apps/desktop -> scene-ui-dom -> scene-runtime
web test/application host -> scene-ui-dom -> scene-runtime
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
- 原生 Live2D 每帧更新可以产生候选动作/物理值，但 Runtime 拥有的参数必须在 `beforeModelUpdate` 最终覆盖后才能提交给 Cubism。
- UI 不读取 `_wavFileHandler`、`internalModel` 等第三方私有字段；这些兼容细节只能留在适配器内部。
- Electron renderer 不直接修改窗口位置或全局状态；bounds 和鼠标穿透由 main 持有并通过白名单 IPC 更新。
- Windows 专属且 Electron 未暴露的短调用由 main 内的 Koffi shell adapter 统一访问；领域包和 renderer 不导入 FFI，已有 Electron API 的能力不重复建立 Win32 状态所有权。
- `scene-ui-dom` 是 Web 与 Electron 共享的 DOM adapter，只消费 Scene Frame、注册 presenter 并路由 UI 事件；Electron 的透明窗口、bounds 和 IPC 能力不得下沉到该包。
- 现有网页诊断页面继续作为测试夹具存在；它只在共享 DOM Host 旁装配测试控件，不作为产品 UI 或 Runtime 状态所有者。
- 参考仓库不进入构建、打包和运行时依赖。

## 参考代码阅读结论

### Open-LLM-VTuber (`992309c`)

- `ServiceContext` 聚合 ASR、TTS、Agent、Live2D 与 MCP provider，工厂模式便于切换实现，但对本项目首版过重。
- conversation 层把文本、actions、音频、音量切片组成 WebSocket payload，证明“协议携带表演意图、前端负责播放”可行。
- 前端播放开始/完成会反馈后端，说明播放生命周期不能用 TTS 请求完成时间替代。
- 详细的模块映射、适用边界和落地约束见 [Open-LLM-VTuber 模块化参考](references/open-llm-vtuber.md)。

### Open-LLM-VTuber-Web (`d176e7d`)

- Electron 明确拆分 `main`、`preload`、`renderer`；窗口透明、置顶、鼠标穿透由主进程管理。
- Scene UI 以框架无关 Surface 与世界绘制项共享 revision；应用 presenter 只消费状态并回传事件，设计见 [桌面 UI 引擎层](desktop-ui-engine.md)。
- WebSocket handler 负责协议分发，audio task queue 保证分句顺序，Live2D hook 负责模型表现。
- 当前实现会直接访问 Live2D 的 `_wavFileHandler` 等私有成员；本项目改为 `LipSyncSource` 与 `Live2DRenderer` 公共接口，避免 UI 与 SDK 版本绑定。

### NagaAgent (`3b84e9e`)

- `live2dController.ts` 把 state、action、emotion、tracking、mouth 分成独立通道，再在帧更新时合成，适合作为 Avatar Runtime 的直接思想来源。
- action queue、关键帧插值、表情淡入淡出、鼠标追踪均应留在运行时层。
- 其 talking 状态中的随机 viseme 只能作为无音频数据时的降级；首版优先使用真实音频包络或 TTS viseme 时间戳。

### Qwen3-TTS (`022e286`)

- 模型 README 描述低延迟流式架构，但当前公开 `generate_*()` 仍返回完整 `List[np.ndarray]` 和采样率。
- `non_streaming_mode=false` 只模拟流式文本输入；内部 `chunked_decode()` 最终也会拼接所有块后返回，不能直接视为音频流接口。
- 本项目因此把 MCP 作为控制面、HTTP 作为音频数据面，并要求真实 provider 在整句完成前产出字节；只对完整波形事后分片不能降低首包延迟。
- 详细代码路径和落地映射见 [Qwen3-TTS 流式实现阅读记录](references/qwen3-tts.md)。

## 当前实施进度

1. 已完成 Runtime 单一状态所有权、Planner、Timeline、分层 Mixer 和中断 generation。
2. 已使用真实 Mao 验证模型加载、hit test、帧末参数写入、动作和持续 Gaze。
3. 已完成流式优先 TTS Adapter、PCM 播放时钟、电平口型和先验提示音验收。
4. 已完成角色级 GazeProfile，并对 Mao 的纵向非对称表现做运行时校准。
5. 已完成 Electron 透明窗口、安全 preload、透明区穿透、角色点击/拖动和 bounds 同步。
6. 已接入可动态启停的语音合成 MCP Client、角色接入 MCP Server 与兼容 Agent HTTP；后续 ASR/真实 Agent 仍只通过 Event/Effect 端口连接。

外部 Agent 可通过角色接入 MCP 或兼容的 `127.0.0.1` HTTP 控制面发送完整 `PerformancePlan` 和中断请求，由 Electron main 转为白名单 IPC，再由 renderer 提交 Runtime；Agent 通过 Runtime snapshot 判断实际播放完成。角色接入 MCP 工具与动态服务管理见 [MCP 服务生命周期](mcp-services.md)，HTTP 请求结构见 [外部 Agent 本地 HTTP 接入指南](external-agent-http.md)。
