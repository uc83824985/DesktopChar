# 角色聊天气泡

## 归属与状态边界

聊天气泡是应用层的只读 `world-overlay` presenter，不属于 Live2D Renderer、TTS Adapter 或具体 Scene Actor 类型。Avatar Runtime 独占 `SpeechBubbleState`：有音频的语音内容只接受播放器生命周期事实；语音合成不可用时由 Runtime 将失败 segment 顺序转换为纯文本回退；其他无语音应用通知通过显式 `presentation.chat-bubble-requested` 事件进入完整显示/等待关闭状态。presenter 读取 `AvatarSnapshot.speechBubble` 生成 DOM，不保存定时器或另一份业务状态，也不反向修改 Runtime。

面向用户的 UI 与中文架构说明统一使用“聊天气泡”。现有 `SpeechBubble*` 类型、`speechBubble` 状态字段和 `bubble` 协议字段属于已经落地的稳定技术标识，不代表该 presenter 归属于语音层；它仍是可以承载角色聊天文本的应用层 UI。

当前 DOM presenter 是共享 Scene UI Host 落地前的第一版应用装配。后续迁移到 `scene-ui-dom` 时，保留 `SpeechBubbleConfig` 和 `projectSpeechBubble()`，只替换 DOM Host/定位适配器。

```text
PerformanceSegment.displayText + bubble     AudioSource.durationMs/textCues
                    \                         /
          playback.started/progress/level/completed
                              |
             Avatar Runtime SpeechBubbleState
                 hidden -> playing -> holding -> hidden
                              ^                  ^
 presentation.chat-bubble-requested     tts.segment-failed
       (application notification)       -> ordered text fallback
                              (both have no playback/lip sync)
                              |
                  projectSpeechBubble()
                              |
                   read-only DOM presenter
```

## 三种显示模式

`PerformanceSegment.bubble.mode` 支持：

| 模式 | 表现 | 时钟 |
| --- | --- | --- |
| `complete` | 收到 `playback.started` 后显示完整 `displayText` | 实际音频输出生命周期 |
| `stream` | 按语音 cue、音频时长或字符速率逐步追加 | 实际音频输出位置 |
| `karaoke` | 完整文本常驻，当前语音 cue/字符高亮 | 实际音频输出位置 |

未声明 `bubble` 时默认 `complete`。TTS 准备、流端点创建和首播缓冲期间聊天气泡保持隐藏；只有播放器确认音频开始输出后才进入 `playing`。`playback.completed` 后三种模式都会补全全文并进入 `holding`，默认延迟 800 ms 隐藏；可用 `dismissDelayMs` 为 segment 覆盖。播放失败或用户中断立即隐藏，不等待延迟。

## 无可用 TTS 时的纯文本回退

语音合成 MCP（TTS）被禁用、连接失败或合成失败产生 `tts.segment-failed` 时，Runtime 不再静默跳过该 segment。它进入 `presenting` 状态并按 sequence 依次显示 `displayText`；当前段关闭后才推进下一失败段或已就绪音频，因此并发失败不会互相覆盖。

回退强制使用 `complete`，忽略原 segment 的 `stream`、`karaoke`、cue 和 `dismissDelayMs`，因为此时不存在可引用的实际播放时钟。它不创建 AudioSource，不产生 `playback.started/progress/level`，嘴型保持中立。显示时长使用可预测的阅读经验值：`clamp(1200ms + 非空白 Unicode 字符数 × 180ms, 2000ms, 12000ms)`；24 字约为 5.52 秒。Agent 可从 capabilities 的 `supportsTextFallback`、`textFallbackMode` 和 `textFallbackDuration` 读取该能力。

`stream` 和 `karaoke` 的文本同步优先级为：

1. TTS `AudioSource.textCues`，但仅在所有 cue 严格拼接为 `displayText` 时采用；
2. `PerformanceSegment.bubble.cues`；
3. TTS 已知 `durationMs`，将 Unicode code point 均匀投影到整段真实音频时长；
4. 都不可用时才按 `charactersPerSecond` 降级，默认每秒 8 个 code point。

暂停时输出位置冻结，因此追加和高亮也冻结。下一段语音开始时会原子替换仍处于 `holding` 的上一段聊天气泡，并取消旧关闭任务。

```json
{
  "id": "reply-1-0",
  "sequence": 0,
  "displayText": "你好，欢迎回来。",
  "speechText": "你好，欢迎回来。",
  "bubble": {
    "mode": "karaoke",
    "dismissDelayMs": 800,
    "cues": [
      { "text": "你好，", "atMs": 0, "durationMs": 450 },
      { "text": "欢迎回来。", "atMs": 450, "durationMs": 900 }
    ]
  }
}
```

校验规则：cue 必须按 `atMs` 非递减排列、时间非负、可选 `durationMs` 大于零，`dismissDelayMs` 必须非负，所有 cue 的 `text` 必须按顺序严格拼接为 `displayText`。这样 presenter、Agent 和 TTS 对齐器不会对文本索引产生不同解释。

## “流式”当前边界

当前 Agent HTTP 协议仍接收完整 `PerformancePlan`。因此 `stream` 表示收到计划后的渐进显示，不表示 HTTP token/chunk 增量提交：

- TTS 返回 `text_cues`：按实际合成结果的字/词时间块显示；
- Agent 提供 cue：按作者时间块显示；
- 只有音频时长：把文本均匀分布到完整语音；
- 以上均无：按播放位置和字符速率产生 typewriter 降级；
- 真正的 LLM token 流需要后续增加 generation-safe 的 segment text append 协议，不能让 presenter 自己订阅 Agent 网络流。

仓库根目录的本地 MCP 默认使用固定音高 `jrpg-blip` 逐字提示音，也可选择确定性变化音调 `jrpg-blip-varied`；二者均返回直接由 PCM 采样帧换算的逐字 `text_cues`。中文逗号、句号等标点对应静音停顿；在 `displayText === speechText` 时，这些 cue 会自动覆盖字符速率降级，用于前台验证“字出现、提示音、嘴型电平”来自同一播放时点。

当前 Qwen3-TTS 参考仓库的 Python 高层生成接口返回 waveform 和 sample rate，没有返回字/词时间戳。因此原生 Qwen3-TTS 只能提供音频级同步；若需要精确 KTV，MCP 包装层需要额外运行对齐器并返回 `text_cues`，或由 Agent 提供已经对齐的 `bubble.cues`。没有对齐信息时的时长均分/逐字符高亮只是稳定降级，不应宣称为强制对齐结果。

## 音频输出同步点

PCM Player 以 Web Audio 输出时间线作为统一基准：

- `playback.started`：`getOutputTimestamp().contextTime` 到达排定的首采样时间；
- `playback.progress/level`：用同一输出位置推进聊天气泡，并从对应 PCM 窗口计算嘴型 RMS；
- `playback.completed`：最后一个 source node 结束且输出时间线到达完整音频时长；
- 不支持 `getOutputTimestamp()` 时降级为 `AudioContext.currentTime`。

规范指出 `currentTime` 是渲染图处理时间，而 `getOutputTimestamp()` 可把 context time 映射到输出音频流；也不应使用二者差值猜测设备延迟，设备延迟应读取 `outputLatency`。参考 [Web Audio API 1.1](https://webaudio.github.io/web-audio-api/#dom-audiocontext-getoutputtimestamp)。

## 前台验收

桌面版可在角色可见像素上右键，打开由 `scene-ui-dom` 即时注册表生成的设置菜单，并从“聊天气泡测试”依次触发完整显示、流式显示和 KTV 高亮。键盘可使用 `Shift+F10` 或 Context Menu 键打开同一菜单；该入口复用正式 UI Host，不是单独的测试面板。

同一菜单的“测试 MCP 连接”会同时探测角色接入 MCP 与语音合成 MCP，并用一次 Runtime 管理的完整聊天气泡显示两端汇总结果。该通知不提交 `PerformancePlan`，不会合成静音或提示音，也不会生成播放进度和口型事件。

流式模式只逐步追加实际文本，不绘制输入框式光标或紫色 caret；它表达的是角色已经开始输出的内容，不暗示用户仍可在聊天气泡中输入。未显示的全文后缀会以不可见、仍参与排版的形式占位，因此气泡从首字开始就按完整 `displayText` 决定宽度与换行，不会在逐字显示期间缩放或改变换行点。气泡整体仍按角色锚点放置，正文内部使用稳定左边界并按中文严格规则自动换行，避免较短首行因逐行居中形成不规则的大缩进；使用 `pre-wrap` 的正文模板禁止在三个投影节点之外保留源码缩进文本，避免 HTML 格式化空白变成首行缩进。中文句号、问号、感叹号及对应全角形式会在 Presenter 视觉层结束当前行，下一句从新行开始；紧随其后的横向空格会在视觉投影中移除。该换行不写回 `displayText`，不改变 TTS cue 索引。KTV 高亮不添加会改变字宽的内边距。

本地测试语音由独立 `local-tts-mcp` 服务通过真实 Streamable HTTP MCP 返回 PCM URL，再由另一个 HTTP 请求分块送入与远端 MCP 相同的 `McpTtsAdapter` 和 `WebAudioPcmStreamPlayer`。声音、`playback.level`、嘴型和聊天气泡均由实际输出时间线推进；参考服务现在返回 sample-aligned `duration_ms` 与 `text_cues`，用于前台精确验证提示音、文本和口型时点。未知总时长及无 cue 的字符速率降级继续由 Adapter/Runtime 单元测试覆盖。

完整模式已纳入 Electron smoke：提交“本地语音测试”后先验证 TTS/缓冲期间聊天气泡隐藏，再验证 `playback.started` 后显示；播放完成后验证聊天气泡保持到关闭延迟结束。流式和 KTV 同时覆盖播放期推进。自动测试还会比较流式显示前后气泡的屏幕矩形，确保全文占位使排版保持稳定。

自动测试覆盖播放开始门控、输出位置推进、TTS cue 优先级、已知时长降级、KTV 高亮、完成后延迟、多段替换、中断清理，以及 TTS 失败后无口型的完整文本回退和多失败段顺序展示：

```powershell
npm test
npm run test:desktop-smoke
```

前台调试可观察：

- `body[data-speech-bubble]`：`hidden | complete | stream | karaoke`；
- `#speech-bubble[data-mode]`：当前 presenter 模式；
- `/v1/state.snapshot.speechBubble`：`phase`、实际输出或纯文本回退的 `positionMs/durationMs` 及当前 presentation；
- `/v1/state.snapshot.playback.positionMs`：播放器公开的实际输出时钟。
