# Live2D 自动动作审阅工具

## 目标

`motion:audit` 是开发期资产分析工具。它从当前角色 `model3.json` 枚举 Motion，在隔离的
真实 WebGL Renderer 中逐项播放，以受预算约束的采样计划导出：

- 透明背景单帧 PNG；
- 每个 Motion 一张按时间排序的 Contact Sheet；
- 固定采样、曲线重要性补采目标和实际播放时点；
- 原始 `motion3.json` 元数据与动态曲线摘要；
- 每个采样点相对基准姿态的参数变化和 Drawable opacity 变化；
- 可见 Drawable 数量、模型包围盒和实际 Motion 状态；
- 面向 Agent 的 `agent-brief.md` 和完整 `manifest.json`。

它不为动作自动写入正式语义，也不绕过 Avatar Runtime 执行业务动作。Agent 输出的语义、
阶段和兼容性判断仍是待人工复核的 Profile 候选。

## 使用

默认审阅当前角色声明的全部 Motion：

```powershell
npm run motion:audit
```

默认使用 500ms 固定采样、曲线事件前后 150ms 补采、150ms 恢复帧，总计最多 144 帧、
单 Motion 最多 32 帧，每个 Motion 最多请求 6 个补采点。
生成目录为：

```text
artifacts/motion-audit/audit-<timestamp>/
```

该目录已加入 `.gitignore`，不会把大量审阅 PNG 误提交到仓库。

常用过滤和预算参数：

```powershell
npm run motion:audit -- --groups TapBody
npm run motion:audit -- --motions TapBody:3,TapBody:4
npm run motion:audit -- --interval-ms 500 --max-frames 80
npm run motion:audit -- --output artifacts/motion-audit/mao-review
npm run motion:audit -- --headed
```

完整参数：

| 参数 | 默认值 | 作用 |
| --- | ---: | --- |
| `--interval-ms` | 500 | 固定时间采样请求间隔 |
| `--recovery-ms` | 150 | 停止动作后等待基准姿态恢复的时间 |
| `--max-frames` | 144 | 本次所有 Motion 共用的总帧预算 |
| `--max-frames-per-motion` | 32 | 单个 Motion 的帧预算 |
| `--importance-radius-ms` | 150 | 重要曲线事件前后的补采半径 |
| `--importance-samples-per-motion` | 6 | 单 Motion 最多新增的曲线补采帧；设为 0 可关闭 |
| `--groups` | 全部 | 只审阅指定 Motion group |
| `--motions` | 全部 | 只审阅指定 `group:index` |
| `--viewport` | `720x900` | 单帧渲染尺寸 |
| `--headed` | 关闭 | 显示采集使用的 Edge 窗口 |

总帧预算还存在不可通过命令行突破的 160 帧硬上限。预算不足时，规划器先为每个已选择
Motion 保留至少一帧，再按相对覆盖率公平分配剩余预算，并在各自时间轴上均匀抽取；
`sample-plan.json` 和 `manifest.json` 会同时记录 requested、exported 和 omitted 数量，
以及每个被预算舍弃的目标采样点。
如果总预算小于已选择 Motion 数量，工具直接拒绝运行，不会静默漏掉整个资产。

## 输出结构

```text
audit-<timestamp>/
  agent-brief.md
  manifest.json
  sample-plan.json
  contact-sheets/
    Idle-0-mtn_01.png
    TapBody-3-special_01.png
  frames/
    Idle-0-mtn_01/
      000-motion-000000ms.png
      ...
      012-recovery-005720ms.png
```

Agent 应按以下顺序读取，避免把全部原图注入上下文：

1. 每个 Motion 只打开一张 Contact Sheet；
2. 紫色边框帧是 Agent 审阅前已由曲线信息确定的补采点；
3. 根据 `manifest.json` 检查其分数、信号、源事件、曲线 ID 和实际采样误差；
4. 先检查被预算舍弃的 importance 候选，再判断某个快速事件是否不存在；
5. 只有缩略图存在歧义时才打开对应单帧 PNG；
6. 输出候选 actionId、语义标签、阶段和冲突声明，保持 `reviewStatus: proposed`。

`manifest.json` 只保存相对基准发生变化的参数和 Drawable opacity，不重复写入每帧的完整
数组；全局参数定义和 Drawable ID 列表只保存一次。Mao 当前 117 帧审阅的 manifest
约 1MB，八张 Contact Sheet 约 3.3MB，Agent 无需读取约 26MB 的完整单帧集合。
每个导出点还会标明 `fixed-cadence`、`motion-end`、`curve-event-before`、
`curve-event`、`curve-event-after` 或 `baseline-recovery` 原因。

## 隔离与时钟

只有浏览器 URL 显式带 `motionAudit=1` 时，Renderer 才暴露
`window.desktopCharMotionAudit`；桌面 Electron 产品窗口不暴露该接口。审阅准备阶段会：

- 停止 Runtime 和开发预览 Motion；
- 锁定原始 Idle 自动选择；
- 恢复 Neutral expression；
- 禁用 Gaze、呼吸和随机眨眼 Updater；
- 把全部 Core 参数恢复到模型默认值，并保存为 MotionManager 基准；
- 等待两帧完成 Pose/Physics 和 GPU 更新后才开始采样。

采集使用真实播放时钟而不是伪造 `motion3.json` 参数。每个采样点同时记录目标时点、
`performance.now()` 对应的实际 Motion elapsed 和误差。固定间隔已经接近资源结尾时，
距现有采样不足 100ms 的额外末帧会被去重，避免截图开销与自然完成计时竞争。
如果系统调度或截图阻塞使当前目标误差超过 100ms，导出器会在截图前恢复基线、重新播放
同一动作并再次到达该目标，最多重试两次；连续失败会终止导出，不会把失真的帧静默写成
成功产物。

2026-07-24 对 Mao 全部八项 Motion 的首轮验证导出 117 帧，最大采样误差约 46ms；
该精度用于 500ms 粒度的语义和阶段审阅足够，但不能替代音频同步或逐帧动画验收。
加入曲线重要性后，同一资产生成 164 个候选并在默认预算内导出 144 帧：117 个固定/末尾/
恢复点、27 个重要性补采点，20 个候选明确记录为 omitted。最终全量验证的最大总体误差
约 43ms，重要性帧最大误差约 27ms；补采额外捕获了 Idle 法杖墨滴和 `special_02`
从白色爆炸闪帧切换到烟雾的边界。

## 重要性采样

重要性采样默认发生在 Agent 阅读图片之前，不依赖 Agent 先发现密集段落。规划器只使用
此时确定可用的信息生成候选：

- `motion3.json` 中发生实际值变化的曲线段；
- 250ms 以内的短过渡、Step/InverseStep 边界；
- 参数 ID 和 Target 提供的上下文，例如特效、颜色、可见性、`On`、`Appearance`、
  `PartOpacity`；
- 单个 500ms 窗口中的动态曲线端点密度；
- 特效曲线的首尾变化边界。

相邻 40ms 内的曲线事件会合并并保留相关曲线 ID。规划器按上述信号计算分数，从时间上
去除相邻的重复事件，再为高优先级事件请求 `t-radius / t / t+radius`。距离已有固定点
不足 110ms 的请求不重复截图；该窗口覆盖当前透明整页 PNG 截图的最坏耗时，避免截图尚未
结束就错过下一目标时点。补采帧携带 `score`、`sourceEventMs`、`offsetMs`、
`signals` 和 `curveIds`，Contact Sheet 使用紫色边框提示。

500ms 固定总览在预算允许时完整保留，剩余预算才按全局分数选择补采帧；如果固定总览
本身已经超出预算，最多预留总预算约 15% 给高置信度曲线事件。所有未获预算的候选继续
写入 `omittedSamples`，最终导出始终受 `maxFrames`、`maxFramesPerMotion` 和 160 帧
硬上限约束。

Agent 后验补采仍作为第二级手段：当 Contact Sheet 的语义、阶段边界或遮挡结果仍有
歧义时，使用 `--motions` 只重跑目标动作，并调整补采半径或总预算。它用于解决视觉歧义，
不承担发现第一轮快速事件的职责。当前没有引入 framebuffer 差分；曲线信息更精确、
可复现且不需要先高频渲染整段动作，只有将来遇到“Drawable 变化未暴露为参数曲线”的
资产时才需要追加图像信号。
