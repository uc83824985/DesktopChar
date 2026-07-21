# Avatar Runtime 模块设计

## 核心约束

Avatar Runtime 是角色运行状态的唯一所有者。任何外部模块都不能直接设置 `idle`、`thinking`、`speaking`、表情或动作状态，只能报告已发生的事实或提交用户意图。

```text
UI / Player / TTS / Renderer
           |
           | AvatarEvent
           v
     Runtime Reducer
           |
     Snapshot + Effects
           |
           +--> UI subscribes to Snapshot
           +--> Audio effect runner
           +--> TTS effect runner
           +--> Renderer effect runner
```

该单向数据流必须保持：

1. 外部输入统一转换为 `AvatarEvent`。
2. reducer 根据旧 Snapshot 和 Event 计算新 Snapshot 与 Effects。
3. Runtime 先提交新 Snapshot，再由 effect runner 执行副作用。
4. Effect 的完成、失败或中断重新转换为 Event 送回 Runtime。
5. UI 只订阅 Snapshot，不根据播放器等局部状态自行推导 Avatar 状态。

## Avatar Runtime

Runtime 唯一拥有：

- `AvatarState` 与合法状态转移；
- 当前 performance plan、segment、sequence 和 Timeline；
- 当前表情、动作队列及各参数层状态；
- pause、resume 和 interrupt 的协调语义；
- 当前 session/generation，用于隔离过期异步任务；
- cue 调度、动作策略、优先级和 idle 回落；
- 对外发布的只读 `AvatarSnapshot`。

建议公共接口：

```ts
interface AvatarRuntime {
  dispatch(event: AvatarEvent): void;
  subscribe(listener: (snapshot: AvatarSnapshot) => void): () => void;
  getSnapshot(): AvatarSnapshot;
  dispose(): Promise<void>;
}
```

Runtime 不直接调用 Web Audio、Electron、Pixi、Live2D SDK 或 MCP 客户端。

## Reducer 与 Transition

状态变化统一经过 reducer：

```ts
interface RuntimeTransition {
  snapshot: AvatarSnapshot;
  effects: RuntimeEffect[];
}

function reduce(
  snapshot: AvatarSnapshot,
  event: AvatarEvent,
): RuntimeTransition;
```

Reducer 应尽量保持纯函数特性：相同 Snapshot 和 Event 必须产生相同 Transition。随机动作选择、当前时间、ID 生成和能力查询都应在外部解析后作为 Event 数据传入。

这样可以直接测试状态转移、中断竞争、过期事件和 Effect 顺序，而不需要启动 Electron、音频设备或 Live2D。

## Avatar Snapshot

Snapshot 是 Runtime 对外发布的只读状态，不暴露内部可变集合或第三方对象。

首版至少包含：

```ts
interface AvatarSnapshot {
  state: AvatarState;
  generation: number;
  planId: string | null;
  segmentId: string | null;
  sequence: number | null;
  playback: {
    status: 'idle' | 'loading' | 'playing' | 'paused' | 'stopped';
    positionMs: number;
  };
  emotion: EmotionState;
  gesture: GestureState;
  gaze: GazeState;
  interrupted: boolean;
  lastError?: RuntimeError;
}
```

UI 可以根据 Snapshot 显示状态，但不能反向修改其字段。

## Avatar Event

Event 分为用户意图、上游输入和外部模块事实三类。

### UI 事件

```ts
type UserEvent =
  | { type: 'user.interrupt-requested' }
  | { type: 'user.pause-requested' }
  | { type: 'user.resume-requested' }
  | { type: 'user.gaze-follow-enabled' }
  | { type: 'user.gaze-follow-disabled' }
  | { type: 'user.look-target-changed'; x: number; y: number }
  | { type: 'user.avatar-clicked'; hitArea: string };
```

UI 禁止直接调用 `setState`、`setEmotion`、`playAction` 或写 Live2D 参数。

### 表演计划事件

```ts
type PlanEvent =
  | { type: 'plan.submitted'; plan: PerformancePlan }
  | { type: 'plan.segment-appended'; planId: string; segment: PerformanceSegment }
  | { type: 'plan.completed'; planId: string }
  | { type: 'plan.failed'; planId: string; error: RuntimeError };
```

Runtime 在接受计划前调用 Avatar Planner 完成白名单、强度、冷却和能力降级校验。

### TTS 事件

```ts
type TtsEvent =
  | { type: 'tts.segment-ready'; generation: number; segmentId: string; sequence: number; audio: AudioSource }
  | { type: 'tts.segment-failed'; generation: number; segmentId: string; sequence: number; error: RuntimeError }
  | { type: 'tts.plan-completed'; generation: number; planId: string };
```

TTS 只报告合成事实，不选择播放顺序，不修改 `speaking` 状态。

### 播放器事件

```ts
type PlaybackEvent =
  | { type: 'playback.buffering'; generation: number; segmentId: string; positionMs: number; bufferedMs: number }
  | { type: 'playback.started'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.progress'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.level'; generation: number; segmentId: string; positionMs: number; value: number }
  | { type: 'playback.stalled'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.recovered'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.paused'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.resumed'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.completed'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.interrupted'; generation: number; segmentId: string; positionMs: number }
  | { type: 'playback.failed'; generation: number; segmentId: string; error: RuntimeError };
```

播放器只拥有媒体对象、流缓冲和媒体播放状态。`playback.buffering` 不会让角色提前进入 speaking；Runtime 收到首个可听采样对应的 `playback.started` 后才转换状态。流式口型由播放器基于实际输出采样发送 `playback.level`，卡顿与恢复也只能作为事实事件上报。

### Renderer 事件

```ts
type RendererEvent =
  | { type: 'renderer.ready'; capabilities: AvatarCapabilities }
  | { type: 'renderer.motion-completed'; generation: number; actionId: string }
  | { type: 'renderer.motion-failed'; generation: number; actionId: string; error: RuntimeError }
  | { type: 'renderer.failed'; error: RuntimeError };
```

Renderer 不选择情绪和动作，只报告能力与命令执行结果。

## Runtime Effect

Reducer 通过 Effect 描述外部副作用：

```ts
type RuntimeEffect =
  | { type: 'tts.synthesize'; generation: number; segment: PerformanceSegment }
  | { type: 'tts.cancel'; generation: number }
  | { type: 'audio.play'; generation: number; segmentId: string; source: AudioSource }
  | { type: 'audio.pause'; generation: number }
  | { type: 'audio.resume'; generation: number }
  | { type: 'audio.stop'; generation: number }
  | { type: 'renderer.apply-frame'; frame: ParameterFrame }
  | { type: 'renderer.play-motion'; generation: number; command: MotionCommand };
```

Effect runner 不得私自改变 Runtime 状态。执行结果必须通过对应 Event 返回。

## UI 职责

UI 负责：

- 展示 AvatarSnapshot、字幕、错误和加载状态；
- 收集点击、暂停、恢复、中断和视线目标；
- 将用户操作转换为 UserEvent；
- 执行纯 UI 和桌面窗口交互。

UI 不负责：

- 根据 `isPlaying` 设置 `speaking`；
- 维护表情或动作队列；
- 推进 Timeline；
- 清理中断后的 Runtime 状态；
- 直接访问 Live2D/Pixi 私有字段。

## Audio Runtime / Player 职责

播放器负责：

- 单轨有序播放；
- 真实播放位置和播放生命周期；
- pause、resume、stop；
- 音频资源和 object URL 清理；
- 增量消费 HTTP 音频流并管理首播缓冲、欠载和背压；
- 从实际输出采样计算 `playback.level`，artifact 模式可使用 amplitude envelope；
- 使用 Web Audio 输出时间线发出 `playback.started/progress/completed`，供嘴型、Timeline 和冒泡共享；
- 将媒体事实转换为 PlaybackEvent。

播放器不负责：

- 决定 AvatarState；
- 选择表情或动作；
- 推进非播放相关的业务流程；
- 在中断后自行决定 idle 回落。

## TTS Adapter 职责

TTS Adapter 负责：

- 把纯文本准备为流式优先的 AudioSource，默认要求服务返回可立即打开的流描述；
- 保留可选 viseme、amplitude 或字词 `textCues` 数据；
- 通过 requestId、AbortSignal 和 provider cancel 工具取消；
- 报告 segment ready、failed 和 plan completed。

它不负责播放、表演调度、状态修改或 Renderer 控制。

## Avatar Planner 职责

Planner 在计划进入 Runtime 前完成纯数据规范化：

- emotion/action 白名单；
- intensity 范围裁剪；
- cue 合并和默认值补全；
- 动作冷却、频率和队列策略；
- 根据 AvatarCapabilities 降级；
- 拒绝或忽略未知输入。

建议接口：

```ts
interface AvatarPlanner {
  normalize(
    plan: PerformancePlan,
    capabilities: AvatarCapabilities,
    policy: RuntimePolicy,
  ): NormalizedPerformancePlan;
}
```

Planner 不保存运行状态，不执行 Timeline，不调用 Renderer。

## Timeline 职责

Timeline 是 Runtime 内部组件：

- 按 segment 和相对播放位置触发 cue；
- 消费 `playback.progress` 推进；
- pause 时冻结，resume 后继续；
- interrupt 时取消全部未触发 cue；
- 保证同一 cue 至多执行一次。

Timeline 不使用 TTS 请求时间、音频下载时间或系统墙上时钟推测播放位置。首版以每个 segment 独立时间轴、按 sequence 串行播放。

## Parameter Mixer 职责

Mixer 是帧级纯计算组件：

```ts
interface ParameterMixer {
  mix(
    layers: ParameterLayers,
    capabilities: AvatarCapabilities,
  ): ParameterFrame;
}
```

它负责参数所有权、优先级、Blend 模式、权重、范围裁剪和缺失参数过滤，不负责选择当前情绪和动作。

首版层级优先级：

```text
Safety Clamp
↑
Mouth
↑
Gaze（启用跟随期间）
↑
Gesture
↑
Expression
↑
Base
```

其中 `ParamMouthOpenY` 默认由 Mouth 独占。播放器上报未经增益的真实 `playback.level`；Runtime 通过角色级 `LipSyncProfile.gain` 将同一电平映射到模型开合并钳制到 `0..1`。当前 Mao 默认增益为 `2.5`，Electron 装配可通过 `DESKTOP_CHAR_LIP_SYNC_GAIN` 覆盖，但不能借此修改扬声器音量或播放器事实事件。

眼部跟随是 Runtime 持有的持续模式：模型具备 gaze 能力时默认开启，`user.look-target-changed` 只更新目标；在显式收到 `user.gaze-follow-disabled` 前，提交计划、中断、说话和原生 motion 都不能清除 gaze 层，Gaze 最终拥有 `ParamAngleX/Y` 与 `ParamEyeBallX/Y`。关闭后才释放这些参数给原生 motion/idle。

标准化目标通过角色级 `GazeProfile` 映射到模型参数。每个轴的正负方向可分别配置端点和指数曲线，并共享中心死区；这使 Runtime 保持模型无关，同时允许补偿角色资源的非对称响应。配置调参与资源修改的边界见 [角色视线校准工作流](gaze-calibration.md)。

## Live2D Renderer 职责

Renderer 负责：

- 模型加载、卸载和能力探测；
- 应用已合成的 ParameterFrame；
- 播放无法参数化的原生 motion；
- hit test、resize 和坐标转换；
- 封装 Pixi/Live2D SDK 私有兼容细节。
- 缓存最新完整 ParameterFrame，并在 `beforeModelUpdate`（motion、focus、physics 之后，Cubism `model.update()` 之前）应用；

建议接口：

```ts
interface Live2DRenderer {
  load(source: Live2DModelSource): Promise<AvatarCapabilities>;
  applyFrame(frame: ParameterFrame): void;
  playMotion(command: MotionCommand): Promise<MotionResult>;
  hitTest(x: number, y: number): string[];
  resize(width: number, height: number): void;
  unload(): Promise<void>;
}
```

Renderer 不接受领域级 `setEmotion()`，不理解 LLM、TTS provider、会话或 AvatarState。

## 中断事务

中断由 Runtime 协调，按 generation 隔离旧异步任务：

```text
递增 generation，拒绝旧事件
-> 停止接受当前计划的新 cue
-> 下发 tts.cancel
-> 清除待播放 segment
-> 下发 audio.stop
-> 取消 Timeline
-> 清空动作队列
-> 嘴型归零
-> Gesture 释放参数；Gaze 模式和目标保持不变
-> 表情回落 neutral
-> 状态收敛 idle
```

要求：

- 中断可重复调用；
- 部分 Effect 失败不阻止其余清理；
- 旧 generation 的完成事件必须被忽略；
- `audio.pause()` 不等价于中断完成；
- dispose 使用同一清理机制，但最终不再接受事件。

## 待替换的早期接口

当前骨架中的以下接口违反单一状态所有权原则：

```ts
setState(...)
setEmotion(...)
playAction(...)
speak(...)
lookAt(...)
interrupt(...)
```

它们将在 contracts 细化阶段替换为 `dispatch(event)`、`AvatarSnapshot`、`RuntimeEffect` 和 `RuntimeTransition`。在替换完成前，不应基于这些直控接口继续开发 UI、播放器或 Renderer 集成。

## 首批契约测试

1. 播放器发出 started 前，Runtime 不进入 speaking。
2. pause 后 Timeline 不继续触发 cue。
3. TTS 乱序完成时仍按 sequence 播放。
4. UI 不能通过公开接口直接设置 AvatarState。
5. Gesture 不覆盖 Mouth 独占参数。
6. 连续中断多次最终稳定收敛到 idle。
7. 旧 generation 的 TTS、播放和 motion 完成事件被忽略。
8. 缺少 gaze 或 mouth-form 能力时可降级运行。
9. 表情结束后回到角色定义的 neutral，而不是盲目归零。
10. Effect 失败会产生错误 Event，不直接修改 Snapshot。

## 实现状态

截至当前实现节点，前两个阶段已经落地：

- `contracts` 已移除公开状态 setter，改为 Event、Snapshot、Effect 和 Transition；
- reducer 是状态变化的统一入口，并按 generation 忽略过期异步事件；
- Planner 会排序 segment、验证 ID/sequence、裁剪情绪强度并按角色能力降级；
- Timeline 只通过 playback position 推进，支持 pause、resume、cancel 和 cue 去重；
- Mixer 按 Base、Expression、Gesture、Gaze、Mouth 顺序合成并过滤模型不支持的参数；
- Gaze 是可显式进入/退出的持续模式，默认开启且跨 plan、speech、motion 和 interrupt 保持；
- 角色级 GazeProfile 已支持四个头眼轴、正负方向独立端点/曲线以及中心死区；Mao 的纵向配置已按资源非对称表现校准；
- Runtime 支持 TTS 并行就绪、sequence 顺序播放、单轨 Player、动作 cue、amplitude mouth、中断和错误回流；
- Fake Effect Executor 覆盖了 TTS、Player 和 Renderer 的端到端行为。
- Live2D 前台已使用真实 Mao 模型验证帧末参数应用、PCM 口型、原生 `TapBody` motion 和持续眼部跟随。

当前已接入真实 Streamable HTTP MCP 控制面与 HTTP PCM 数据面：默认 `local_tts_mcp` 和外部 Qwen3-TTS MCP 都通过相同 Adapter/Player 端口进入 Runtime，不能绕过 Runtime 修改状态。装配与外部 Agent 使用方式见 [外部 Agent 本地 HTTP 接入指南](external-agent-http.md)。
