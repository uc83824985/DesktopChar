# 先验铃声流与口型时点验收

## 验收目标

该用例验证同一份 PCM 数据能否按播放时钟同时驱动可听声音和 Live2D 嘴部参数，覆盖：

```text
已知 PCM 分片
  -> Web Audio 排程与播放
  -> 从已排程 PCM 计算 playback.level
  -> Avatar Runtime / Parameter Mixer
  -> renderer.apply-frame
  -> Mao ParamA 写入并回读
  -> Pixi 完成下一次渲染帧
```

它不使用 Mock 预计算的 amplitude 数组，因此 Runtime 无法绕过实际 PCM 数据“猜”出口型。只有播放器轨道、模型参数轨道和逐点响应时延都满足条件时，前台才显示通过。

## 测试素材

素材由代码确定性生成，无需提交二进制音频文件，也没有第三方铃声版权问题：

| 区间 | 内容 | 频率 | 目标电平 |
| --- | --- | ---: | ---: |
| 0–200ms | 静音 | — | 0 |
| 200–400ms | 提示音 1 | 660Hz | 0.25 |
| 400–600ms | 静音 | — | 0 |
| 600–850ms | 提示音 2 | 880Hz | 0.55 |
| 850–1050ms | 静音 | — | 0 |
| 1050–1400ms | 提示音 3 | 1100Hz | 0.85 |
| 1400–1600ms | 静音 | — | 0 |

格式为 24 kHz、单声道、`pcm_s16le`。每个提示音边界使用 12ms 淡入淡出避免爆音；流默认按 20ms PCM 块输出。电平从同一批 PCM 样本的 20ms RMS 窗口计算，并乘以 `sqrt(2)` 还原正弦峰值尺度。

## 自动验收条件

播放器 `playback.level` 轨道和 Mao `ParamA` 回读轨道分别检查：

- 三段稳定区间的电平与 0.25、0.55、0.85 偏差不超过 0.12；
- 每段提示音的开始和结束相对先验时间表偏差不超过 90ms；
- 四个静音检查窗口的最大电平不超过 0.08；
- 后一段提示音必须比前一段至少高 0.12；
- 必须走完 `buffering -> started -> progress/level -> completed`。
- 每一个 `playback.level` 都必须产生 Mao `ParamA` 写入和后续 Pixi 渲染帧记录；
- 电平事件进入前台到模型参数写入的最大响应时间不超过 12ms；
- 电平事件进入前台到 Pixi 完成下一次渲染帧的最大响应时间不超过 50ms。

纯数据测试还会把正确电平轨道整体后移 180ms，并确认验收器拒绝该轨道；另有响应测试会注入 20ms 参数延迟和缺失渲染帧并确认失败，避免测试只检查“嘴有动”而不检查时点或响应完整性。

## 前台快速验证

执行：

```bash
npm start
```

点击“口型同步验收”。可以听到三段逐渐增强的提示音，并观察嘴部按相同节奏开合。页面会实时显示：

- 播放端：音频位置、PCM 电平和当前静音/提示音阶段；
- 口型参数：Mao 实际 `ParamA` 及相对播放事件的响应差；
- 下一屏幕帧：Pixi 完成下一次渲染后的响应差；
- 最近约 100ms 一个采样点以及音段切换点的滚动日志。

结果写入：

```text
body[data-tone-acceptance="running|passed|failed"]
body[data-tone-acceptance-metrics="..."]
```

浏览器控制台同时输出结构化日志：

```json
{"event":"tone.sync.trace","audioPositionMs":1100,"phase":"提示音 3","playbackLevel":0.85,"modelValue":0.85,"modelResponseMs":0.2,"frameResponseMs":14.6}
{"event":"tone.sync.result","passed":true,"player":{},"model":{},"response":{}}
```

自动化入口：

```bash
npm run test:smoke
```

Smoke test 会在 Edge 中加载真实 Mao 模型、触发用户点击、实际创建 Web Audio 播放节点，并检查屏幕 trace、播放器轨道、模型参数轨道和响应时延。2026-07-20 的一次本轮验证结果为：时轴误差 21.3ms、最大模型参数响应 0.10ms、最大 Pixi 渲染帧响应 12.40ms；墙钟调度结果允许在阈值内随运行负载波动。

## 当前边界

`WebAudioPcmStreamPlayer` 当前只承诺单声道 `pcm_s16le`，已覆盖分片拼接、首播缓冲、实际播放时钟、PCM 电平、暂停/恢复/停止和生命周期事件。测试 fixture 的生产速度明显快于播放速度，因此尚未以该用例覆盖长期背压、真实网络抖动和反复欠载恢复；这些应在接入真实 Qwen3-TTS HTTP 流时增加独立压力测试。

这里的“播放端时点”来自 Web Audio `AudioContext.currentTime`，“屏幕帧”记录发生在优先级低于 Application renderer 的 Pixi ticker 回调中。它能测量应用内部的音频时钟到模型/渲染路径差异，但不包含操作系统音频缓冲、扬声器/DAC 声学延迟，也不包含显示器扫描输出延迟。
