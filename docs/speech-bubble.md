# 角色语音聊天冒泡

## 归属与状态边界

聊天冒泡是应用层的只读 `world-overlay` presenter，不属于 Live2D Renderer、TTS Adapter 或具体 Scene Actor 类型。Avatar Runtime 独占 `SpeechBubbleState`，并只接受播放器生命周期事实；presenter 读取 `AvatarSnapshot.speechBubble` 生成 DOM，不保存定时器或另一份业务状态，也不反向修改 Runtime。

当前 DOM presenter 是共享 Scene UI Host 落地前的第一版应用装配。后续迁移到 `scene-ui-dom` 时，保留 `SpeechBubbleConfig` 和 `projectSpeechBubble()`，只替换 DOM Host/定位适配器。

```text
PerformanceSegment.displayText + bubble     AudioSource.durationMs/textCues
                    \                         /
          playback.started/progress/level/completed
                              |
             Avatar Runtime SpeechBubbleState
                 hidden -> playing -> holding -> hidden
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

未声明 `bubble` 时默认 `complete`。TTS 准备、流端点创建和首播缓冲期间冒泡保持隐藏；只有播放器确认音频开始输出后才进入 `playing`。`playback.completed` 后三种模式都会补全全文并进入 `holding`，默认延迟 800 ms 隐藏；可用 `dismissDelayMs` 为 segment 覆盖。播放失败或用户中断立即隐藏，不等待延迟。

`stream` 和 `karaoke` 的文本同步优先级为：

1. TTS `AudioSource.textCues`，但仅在所有 cue 严格拼接为 `displayText` 时采用；
2. `PerformanceSegment.bubble.cues`；
3. TTS 已知 `durationMs`，将 Unicode code point 均匀投影到整段真实音频时长；
4. 都不可用时才按 `charactersPerSecond` 降级，默认每秒 8 个 code point。

暂停时输出位置冻结，因此追加和高亮也冻结。下一段语音开始时会原子替换仍处于 `holding` 的上一段冒泡，并取消旧关闭任务。

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
- `playback.progress/level`：用同一输出位置推进冒泡，并从对应 PCM 窗口计算嘴型 RMS；
- `playback.completed`：最后一个 source node 结束且输出时间线到达完整音频时长；
- 不支持 `getOutputTimestamp()` 时降级为 `AudioContext.currentTime`。

规范指出 `currentTime` 是渲染图处理时间，而 `getOutputTimestamp()` 可把 context time 映射到输出音频流；也不应使用二者差值猜测设备延迟，设备延迟应读取 `outputLatency`。参考 [Web Audio API 1.1](https://webaudio.github.io/web-audio-api/#dom-audiocontext-getoutputtimestamp)。

## 前台验收

桌面版可在角色可见像素上右键，打开由 `scene-ui-dom` 即时注册表生成的设置菜单，并从“冒泡效果测试”依次触发完整显示、流式显示和 KTV 高亮。键盘可使用 `Shift+F10` 或 Context Menu 键打开同一菜单；该入口复用正式 UI Host，不是单独的测试面板。

流式模式只逐步追加实际文本，不绘制输入框式光标或紫色 caret；它表达的是角色已经开始输出的内容，不暗示用户仍可在冒泡中输入。

本地测试语音由独立 `local-tts-mcp` 服务通过真实 Streamable HTTP MCP 返回 PCM URL，再由另一个 HTTP 请求分块送入与远端 MCP 相同的 `McpTtsAdapter` 和 `WebAudioPcmStreamPlayer`。声音、`playback.level`、嘴型和冒泡均由实际输出时间线推进；参考服务默认不附带时长和文本 cue，因此流式冒泡入口同时验证未知总时长时的字符速率降级。

完整模式已纳入 Electron smoke：提交“本地语音测试”后先验证 TTS/缓冲期间冒泡隐藏，再验证 `playback.started` 后显示；播放完成后验证冒泡保持到关闭延迟结束。流式和 KTV 同时覆盖播放期推进。

自动测试覆盖播放开始门控、输出位置推进、TTS cue 优先级、已知时长降级、KTV 高亮、完成后延迟、多段替换和中断清理：

```powershell
npm test
npm run test:desktop-smoke
```

前台调试可观察：

- `body[data-speech-bubble]`：`hidden | complete | stream | karaoke`；
- `#speech-bubble[data-mode]`：当前 presenter 模式；
- `/v1/state.snapshot.speechBubble`：`phase`、实际输出 `positionMs`、TTS 时长及当前 presentation；
- `/v1/state.snapshot.playback.positionMs`：播放器公开的实际输出时钟。
