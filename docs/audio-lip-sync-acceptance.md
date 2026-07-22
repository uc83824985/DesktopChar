# 先验铃声流与口型时点验收

## 验收目标

该用例验证同一份 PCM 数据能否按播放时钟同时驱动可听声音和 Live2D 嘴部参数，覆盖：

```text
已知 PCM 分片
  -> Web Audio 排程与播放
  -> 从已排程 PCM 计算 playback.level
  -> Avatar Runtime / Parameter Mixer
  -> renderer.apply-frame
  -> 缓存最新 Runtime ParameterFrame
  -> Live2D beforeModelUpdate 帧末写入 Mao ParamA 并回读
  -> Pixi postrender 完成实际送屏
```

它通过真实本地 MCP 请求中的 `test_fixture: "known-tone-v1"` 返回 HTTP 流，不携带预计算 amplitude 数组，因此 Runtime 无法绕过实际 PCM 数据“猜”出口型。只有播放器轨道、模型参数轨道和逐点响应时延都满足条件时，前台才显示通过。

该按钮只在当前 Provider 的 `tts_status.capabilities.test_fixtures` 包含 `known-tone-v1` 时启用。未声明该能力的 Provider 不会收到 `test_fixture`，判断不依赖 Provider 名称或 `managed/external` 生命周期。

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

格式为 24 kHz、单声道、`pcm_s16le`。每个提示音边界使用 12ms 淡入淡出避免爆音；流默认按 20ms PCM 块输出。播放器从同一批 PCM 样本的 20ms RMS 窗口计算原始电平，并乘以 `sqrt(2)` 还原正弦峰值尺度。Runtime 随后使用当前角色的 `LipSyncProfile` 映射嘴型；Mao 当前为 `gain=2.5`、`attackMs=30`、`releaseMs=180`、`peakHoldMs=25`。gain 只改变模型响应，时间参数只改变嘴型包络，均不改变音频输出音量和原始 `playback.level`。

## 自动验收条件

播放器 `playback.level` 轨道和 Mao `ParamA` 回读轨道分别检查。前者保持 0.25、0.55、0.85 的原始电平，后者按当前 gain 检查，默认期望为 0.625、1、1：

- 三段稳定区间的电平与各自轨道的期望值偏差不超过 0.12；
- 每段提示音的开始和结束相对先验时间表偏差不超过 90ms；
- 四个静音检查窗口的最大电平不超过 0.08；模型轨道的检查窗口会按 peak hold、25ms 采样周期和 release 留出确定性的收口时间，播放器原始轨道不使用该宽限；
- 仅当增益钳制后的相邻期望值仍相差至少 0.12 时，后一段才必须保持可观测的增强；
- 必须走完 `buffering -> started -> progress/level -> completed`。
- 每一个 `playback.level` 都必须产生 Mao `ParamA` 写入和后续 Pixi 渲染帧记录；
- 电平事件进入前台到下一次 Live2D 帧末参数写入的最大响应时间不超过 34ms；
- 电平事件进入前台到 Pixi 完成下一次渲染帧的最大响应时间不超过 50ms。

纯数据测试还会把正确电平轨道整体后移 180ms，并确认验收器拒绝该轨道；另有响应测试会注入 40ms 参数延迟和缺失渲染帧并确认失败，避免测试只检查“嘴有动”而不检查时点或响应完整性。包络单测另外验证快速张嘴、峰值保持、渐进闭嘴、播放位置确定性和零平滑诊断模式。34ms 允许正常 60Hz 环境中最多约两个帧间隔，但仍会拒绝持续丢帧或事件未进入 Live2D 更新周期。

不能在收到 `renderer.apply-frame` 时立刻写 Core 参数。`pixi-live2d-display` 随后还会执行 motion、expression、eye blink、focus、breath、physics 和 pose，它们会覆盖提前写入的值。前台使用 `beforeModelUpdate` 作为 Runtime 最终写入点：先让上述模型机制运行，再覆盖 Runtime 当前拥有的 mouth/gaze 参数，随后立即调用 Cubism `model.update()`。验收中的 `modelValue` 因而是实际参与本帧网格计算的值，而不是可被覆盖的同步回读值。

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

Smoke test 会在 Edge 中加载真实 Mao 模型、触发用户点击、实际创建 Web Audio 播放节点，并检查屏幕 trace、播放器轨道、帧末模型参数轨道和响应时延；它还会验证模拟说话、真实 `TapBody` motion，以及眼部跟随在动作期间保持启用并可显式退出。2026-07-20 的一次本轮验证结果为：时轴误差 32.0ms、最大帧末模型参数响应 15.70ms、最大 Pixi 送屏响应 17.10ms；墙钟调度结果允许在阈值内随运行负载波动。

## 当前边界

`WebAudioPcmStreamPlayer` 当前只承诺单声道 `pcm_s16le`，已覆盖分片拼接、首播缓冲、实际播放时钟、PCM 电平、暂停/恢复/停止和生命周期事件。测试 fixture 的生产速度明显快于播放速度，因此尚未以该用例覆盖长期背压、真实网络抖动和反复欠载恢复；这些应在接入真实 Qwen3-TTS HTTP 流时增加独立压力测试。

这里的“播放端时点”来自 Web Audio `AudioContext.currentTime`，“模型参数”记录发生在 Live2D 的 `beforeModelUpdate`，“屏幕帧”记录来自 Pixi renderer 的 `postrender` 事件。它能测量应用内部的音频时钟到模型/渲染路径差异，但不包含操作系统音频缓冲、扬声器/DAC 声学延迟，也不包含显示器扫描输出延迟。
