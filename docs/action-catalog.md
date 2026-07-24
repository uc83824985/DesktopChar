# 角色级动作目录与 Mao 资产审阅

## 目的

Live2D `model3.json` 中的 Motion group、index 和文件名只是 Renderer 资源身份，不能直接
充当跨角色的语义动作。正式动作接入需要同时具备：

1. 角色 Profile 中面向表现选择器的动作描述；
2. 描述到 Live2D Motion group/index 的角色级 binding；
3. Avatar Runtime 对时序、冲突、打断和完成事件的唯一管理；
4. Renderer 按 binding 播放真实资源并以真实时长报告完成；
5. 资源可达性、完整播放和语义候选可达性测试。

开发期资源面板只证明原始 Motion 可以加载和播放，不代表以上链路已经完成。

## Mao 当前人工审阅

2026-07-24 已在“基准姿态锁定”状态下逐项完成前台视觉审阅。表中时长来自对应
`motion3.json` 的 `Meta.Duration`；文件虽然都声明 `Loop: true`，但这里列出的六个
`TapBody` 资源均应按一次完整表演使用，由动作 binding 明确覆盖原始循环属性。

| 原始身份 | 文件 | 时长 | 已确认的视觉事实 | 候选逻辑键 |
| --- | --- | ---: | --- | --- |
| `Idle[0]` | `mtn_01.motion3.json` | 5.57s | 普通待机，无测试球 | `idle-default` |
| `Idle[1]` | `sample_01.motion3.json` | 5.57s | 主体曲线与 `Idle[0]` 相同，额外显示并驱动乘算色/屏幕色测试球 | `render-feature-sample` |
| `TapBody[0]` | `mtn_02.motion3.json` | 3.47s | 闭眼，像企鹅一样双臂摆动两次 | `penguin-double-wave` |
| `TapBody[1]` | `mtn_03.motion3.json` | 4.40s | 双手背在身后，闭眼左右摇晃 | `hands-behind-sway` |
| `TapBody[2]` | `mtn_04.motion3.json` | 4.20s | 左手扶住并整理法师帽 | `adjust-wizard-hat` |
| `TapBody[3]` | `special_01.motion3.json` | 7.80s | 右手抬起法杖，成功画出爱心 | `draw-heart-success` |
| `TapBody[4]` | `special_02.motion3.json` | 9.37s | `special_01` 的失败差分：抬起法杖画爱心，结尾失败爆炸并懊恼 | `draw-heart-failure` |
| `TapBody[5]` | `special_03.motion3.json` | 9.23s | 右手抬起法杖召唤兔子；兔子像 Buff 一样围绕角色持续表演一段时间后消失 | `summon-rabbit-buff` |

`sample_01` 是官方渲染特性样例，不应进入 Agent、表现模型或随机语义动作的候选集；
只保留在 Renderer 开发诊断面板。上表候选逻辑键用于后续 Profile schema 和 binding
实现，原始 group/index 永远保留在 Renderer 侧，不暴露给模型协议。

## 当前接入状态

截至 2026-07-24，Mao 动作尚未完整接入：

- **原始资源发现与手动预览已完成**：开发面板会从 `Mao.model3.json` 自动列出两个
  `Idle` 和六个 `TapBody` Motion，并按资源声明时长停止预览；
- **人工视觉审阅已完成**：六个 `TapBody` 的视觉内容已记录在上表；
- **角色语义目录未实现**：`DesktopChar.character.json` 仍只有旧字段
  `allowedActions: ["nod"]`，不存在与 ExpressionCatalog 对等的 ActionCatalog；
- **角色 binding 未实现**：Profile 尚不能把逻辑动作映射到 Motion group/index、
  播放模式、真实时长、参数所有权或说话兼容性；
- **Runtime Renderer 路径仍是占位实现**：收到任意 `renderer.play-motion` Effect 都会
  固定播放 `TapBody[0]`，忽略命令中的语义 `action`；
- **完成时点不正确**：占位路径固定在 1200ms 后停止，而 Mao 最短的 `mtn_02` 也有
  3.47s，导致正式 Runtime 路径无法完整播放现有动作；
- **表现选择器不可见六项资产**：当前只把 `nod` 作为无标签的
  `PerformanceActionDescriptor` 发送给本地表现模型；
- **正式回归缺失**：现有测试只确认原始资源数量和手动预览身份，尚未覆盖逻辑动作到
  真实 Motion 的逐项可达性、真实完成时点、失败/打断和说话冲突。

因此目前不能把 `nod` 解释为 `mtn_02` 的正式语义；它只是早期最小链路的动作占位符。

## 后续接入约束

正式实现 ActionCatalog 时至少需要为每项动作声明：

- 稳定 `actionId`、显示名、语义标签和原型文本；
- Renderer `motionGroup/index` binding；
- `once`/`loop` 播放模式与资源实测或声明时长；
- 可用 Runtime 状态、允许的段内锚点和说话兼容性；
- 与 Gaze、表情、口型、身体动作的参数所有权和冲突策略；
- 冷却时间、重复抑制、优先级、是否允许打断及打断后的基准姿态；
- 长表演的阶段性语义，例如 `special_02` 的施法、失败、爆炸和懊恼，以及
  `special_03` 的召唤、Buff 持续和消失。

动作选择器只输出逻辑 `actionId` 和时间锚点。Avatar Runtime 解析并验证 binding 后
才能发出 Renderer Effect；Renderer 不得根据文本、情绪或模型输出自行选择动作。
