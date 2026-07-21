# 角色语音聊天冒泡

## 归属与状态边界

聊天冒泡是应用层的只读 `world-overlay` presenter，不属于 Live2D Renderer、TTS Adapter 或具体 Scene Actor 类型。Avatar Runtime 继续独占活动 `PerformancePlan`、当前 segment 和播放时钟；presenter 读取 `AvatarSnapshot + getActiveSegment()` 生成 DOM，不保存另一份业务状态，也不反向修改 Runtime。

当前 DOM presenter 是共享 Scene UI Host 落地前的第一版应用装配。后续迁移到 `scene-ui-dom` 时，保留 `SpeechBubbleConfig` 和 `projectSpeechBubble()`，只替换 DOM Host/定位适配器。

```text
PerformanceSegment.displayText + bubble
                    |
Avatar Runtime active segment + playback.positionMs
                    |
          projectSpeechBubble()
                    |
         read-only DOM presenter
```

## 三种显示模式

`PerformanceSegment.bubble.mode` 支持：

| 模式 | 表现 | 时钟 |
| --- | --- | --- |
| `complete` | segment 激活后立即显示完整 `displayText` | Runtime segment 生命周期 |
| `stream` | 按 cue 分块或按字符速率逐步追加 | 真实 `playback.positionMs` |
| `karaoke` | 完整文本常驻，当前 cue/字符高亮 | 真实 `playback.positionMs` |

未声明 `bubble` 时默认 `complete`。`stream` 和 `karaoke` 优先使用 `cues`；没有 cue 时按 `charactersPerSecond` 投影，默认每秒 8 个 Unicode code point。暂停时播放位置冻结，因此追加和高亮也冻结；中断、计划结束或 segment 不再活动时冒泡隐藏。

```json
{
  "id": "reply-1-0",
  "sequence": 0,
  "displayText": "你好，欢迎回来。",
  "speechText": "你好，欢迎回来。",
  "bubble": {
    "mode": "karaoke",
    "cues": [
      { "text": "你好，", "atMs": 0, "durationMs": 450 },
      { "text": "欢迎回来。", "atMs": 450, "durationMs": 900 }
    ]
  }
}
```

校验规则：cue 必须按 `atMs` 非递减排列、时间非负、可选 `durationMs` 大于零，所有 cue 的 `text` 必须按顺序严格拼接为 `displayText`。这样 presenter、Agent 和后续 TTS 对齐器不会对文本索引产生不同解释。

## “流式”当前边界

当前 Agent HTTP 协议仍接收完整 `PerformancePlan`。因此 `stream` 表示收到计划后的渐进显示，不表示 HTTP token/chunk 增量提交：

- 有 cue：按作者或上游 Agent 提供的时间块显示；
- 无 cue：按播放位置和字符速率产生 typewriter 效果；
- 真正的 LLM token 流需要后续增加 generation-safe 的 segment text append 协议，不能让 presenter 自己订阅 Agent 网络流。

KTV 精确到词/字需要上游提供 cue。没有对齐信息时的逐字符高亮只是稳定降级，不应宣称为 TTS 强制对齐结果。

## 前台验收

桌面版可在角色可见像素上右键，打开由 `scene-ui-dom` 即时注册表生成的设置菜单，并从“冒泡效果测试”依次触发完整显示、流式显示和 KTV 高亮。键盘可使用 `Shift+F10` 或 Context Menu 键打开同一菜单；该入口复用正式 UI Host，不是单独的测试面板。

流式模式只逐步追加实际文本，不绘制输入框式光标或紫色 caret；它表达的是角色已经开始输出的内容，不暗示用户仍可在冒泡中输入。

完整模式已纳入 Electron smoke：提交现有“模拟说话”计划后，验证 `body[data-speech-bubble="complete"]` 和显示文本；中断后验证 `body[data-speech-bubble="hidden"]`。

自动投影测试覆盖完整、按播放位置流式追加、作者 cue 追加、KTV cue 高亮及 idle 隐藏：

```powershell
npm test
npm run test:desktop-smoke
```

前台调试可观察：

- `body[data-speech-bubble]`：`hidden | complete | stream | karaoke`；
- `#speech-bubble[data-mode]`：当前 presenter 模式；
- `/v1/state.snapshot.playback.positionMs`：流式追加和 KTV 高亮使用的唯一时钟。
