# Live2D 自动动作审阅工具

## 目标

`motion:audit` 是开发期资产分析工具。它从当前角色 `model3.json` 枚举 Motion，在隔离的
真实 WebGL Renderer 中逐项播放，以受预算约束的采样计划导出：

- 透明背景单帧 PNG；
- 每个 Motion 一张按时间排序的 Contact Sheet；
- 固定采样目标和实际播放时点；
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

默认使用 500ms 固定采样、150ms 恢复帧、总计最多 120 帧、单 Motion 最多 32 帧。
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
| `--max-frames` | 120 | 本次所有 Motion 共用的总帧预算 |
| `--max-frames-per-motion` | 32 | 单个 Motion 的帧预算 |
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
2. 根据 `manifest.json` 检查实际采样误差、动态参数和特效出现区间；
3. 只有缩略图存在歧义时才打开对应单帧 PNG；
4. 输出候选 actionId、语义标签、阶段和冲突声明，保持 `reviewStatus: proposed`。

`manifest.json` 只保存相对基准发生变化的参数和 Drawable opacity，不重复写入每帧的完整
数组；全局参数定义和 Drawable ID 列表只保存一次。Mao 当前 117 帧审阅的 manifest
约 1MB，八张 Contact Sheet 约 3.3MB，Agent 无需读取约 26MB 的完整单帧集合。
每个导出点还会标明 `fixed-cadence`、`motion-end` 或 `baseline-recovery` 原因。

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

2026-07-24 对 Mao 全部八项 Motion 的首轮验证导出 117 帧，最大采样误差约 46ms；
该精度用于 500ms 粒度的语义和阶段审阅足够，但不能替代音频同步或逐帧动画验收。

## 后续重要性采样

重要性采样只新增“候选采样点生成器”，继续复用现有预算分配、Renderer 接口和输出
schema。候选重要度可以由以下信号组合：

- `motion3.json` 参数曲线的一阶变化量、Step/InverseStep 边界和离散开关；
- Drawable opacity、可见数量和包围盒突变；
- 相邻低分辨率 framebuffer 的像素差和局部变化面积；
- 特效参数首次开启、峰值、关闭及动作恢复阶段；
- 固定 500ms 基础点和人工指定的保留点。

规划器先保留开始、恢复和高置信度事件点，再在变化密集区增加 100–250ms 补采；所有
候选仍进入同一个 `maxFrames`/`maxFramesPerMotion` 分配器。即使某个资源包含大量粒子、
快速闪烁或长循环，最终导出的图片总数也不能超过硬预算。Manifest 需要为每个补采点
记录 `reason`、重要度分数及被预算舍弃的候选数量，Agent 才能区分“没有变化”和
“变化存在但未获采样预算”。
