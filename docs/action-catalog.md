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
自动逐帧导出、Contact Sheet、参数轨迹和 Agent 审阅顺序见
[Live2D 自动动作审阅工具](motion-audit.md)。

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

截至 2026-07-24，第一版正式动作链路已经接入：

- **资产目录**：Mao Profile 已声明六个逻辑动作的语义、场景适用性、触发规则、
  冷却/排队策略和准确的 `TapBody[index]` binding；
- **诊断资源隔离**：`Idle[1] sample_01` 仍只在 Renderer 开发面板可见，不进入
  Agent、表现推理或随机动作候选；
- **场景投影**：SceneRuntime 保存场景动作语境，并通过
  `projectSceneActionContext()` 输出不含 Actor/Relation 实现细节的版本化投影；
- **Runtime 决策**：独立 ActionRuntime 负责资产与场景的交集筛选、required/chance/weight、
  冷却、忙碌策略、队列、场景变更后的重新校验及 Renderer 生命周期推进；
- **Renderer binding**：桌面 Renderer 按命令中的真实 group/index 播放，并在一次性动作开始前
  覆盖资产源文件的 `Loop: true`；完成以 MotionManager 的 `motionFinish` 为准，
  资产时长只保留为异常超时保护；
- **表现推理**：六个逻辑动作及语义标签会发送给本地表现模型；确定性规则回退也按语义标签
  选择，不再依赖固定 `nod/greet/shake` 槽位；
- **待机接入**：桌面应用每 15 秒在 Runtime 空闲且没有当前动作时提交一次
  `ambient.opportunity`。Mao 三项待机动作使用独立的候选抽样与概率抽样；每项基础
  `chance`、候选 `weight`、冷却和优先级均由角色资产配置，允许按角色表现需要调整，
  Runtime 与测试不复制这些具体数值；
- **对话后增益**：一次完整播放计划结束后提交 `conversation.completed`；默认桌面场景通过
  `triggerChanceMultipliers` 将同一组资产概率放大 3 倍，其他场景可独立调整或设为
  `0` 禁用，最终命中率由当前角色配置动态决定；
- **回归覆盖**：测试已覆盖场景硬过滤、required 与 chance 分离、队列失效、真实完成时点上的
  冷却记录、独立随机样本的候选可达性、加权概率计算、对话后增益、SceneActionContext 投影
  和六项 Mao binding 可达性；资产集成测试只校验参数范围和结构，不锁定用户可调的具体值。

这一版尚未为长动作写入阶段性语义，也尚未实现 ActionCatalog 的文件级热重载入口；
二者均保留在后续迭代范围。

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

## 三模块职责边界

动作播放采用“资产声明适用性、场景声明当前语境、Runtime 统一决策和播放”的双侧约束模型。
三个模块分别独立，不允许场景或 Renderer 绕过 Runtime 直接播放 Motion：

```text
Character ActionCatalog          SceneActionContext
  资产语义、适用性、binding        场景标签、姿态、允许/禁止类别
              \                 /
               \               /
                AvatarRuntime.ActionRuntime
                  筛选、概率、队列、冲突、生命周期
                              |
                              v
                         Renderer Motion
```

### 资产侧：Character ActionCatalog

角色资产拥有动作目录。目录同时保存可公开给表现推理的语义描述，以及绝不能暴露给模型的
Renderer binding：

- `actionId`、显示名、语义标签、原型文本和允许的段内锚点；
- 可用 Avatar 状态、场景标签、姿态和说话兼容性；
- 触发事件、触发模式、概率和候选权重；
- 优先级、冷却、重复窗口、忙碌策略和最大排队时长；
- Live2D `motionGroup/index`、单次/循环模式和预期时长。

具体应用场景 ID 不应成为资产的主要依赖。资产优先声明
`relaxed`、`standing`、`social` 等语义条件，因此同一动作可以跨场景复用。确有专属需求时，
由场景侧规则发出准确 `actionId` 请求，仍由 Runtime 做安全校验。

### 场景侧：SceneActionContext

SceneRuntime 继续拥有场景图，向 AvatarRuntime 提供只读、带版本号的动作语境投影：

- 当前 `sceneId`、generation 和 revision；
- 场景语义标签；
- 角色当前姿态；
- 当前允许和禁止的动作类别；
- 以触发事件为键的 `triggerChanceMultipliers`。它只调整场景中的触发倾向，不修改角色资产
  的基础 `chance`，并在 Runtime 中截断到最大概率 `1`。

场景 Actor、Behavior 和应用逻辑只能产生语义事件或动作意图，不能调用 Renderer。
场景变更后，已排队但尚未开始的动作必须使用最新投影再次校验。

### Runtime 侧：ActionRuntime

ActionRuntime 是 AvatarRuntime 的子模块，并且是动作状态的唯一所有者。它持有：

- 当前动作请求及真实播放阶段；
- 等待队列；
- 动作完成时间、冷却和场景会话内重复历史；
- 当前 SceneActionContext revision。

所有来源统一转换为 ActionIntent：对话表现建议、场景事件、待机机会、Agent 请求、用户交互和
开发面板测试。ActionRuntime 解析 binding 后才产生 `renderer.play-motion` Effect；Renderer
只执行命令并报告开始、完成、中断或失败事实。

## 表情与动作兼容方案

主流动画系统通常把问题拆成两层：

- **参数/骨骼是否重叠**：使用动画层、遮罩、权重以及 Override/Additive 混合。Unity 的
  [Animation Layers](https://docs.unity3d.com/cn/current/Manual/AnimationLayers.html)
  就是按身体区域建立 mask，并为层选择 Override 或 Additive；
- **语义状态能否共存**：使用状态机、优先级和 transition 条件。Godot 的
  [AnimationNodeStateMachineTransition](https://docs.godotengine.org/en/stable/classes/class_animationnodestatemachinetransition.html)
  也把优先级、切换模式和 cross-fade 作为状态转换属性。

Live2D 的约束更直接：[About Motion](https://docs.live2d.com/en/cubism-sdk-manual/motion/)
说明优先级拒绝应在 `CubismMotionManager` 外部管理；并行 Motion 应尽量避免写同一参数，
否则后更新者生效且 fade 可能不干净。其
[Motion Unity](https://docs.live2d.com/en/cubism-sdk-manual/motion-unity/) 文档同样说明多层写入
相同参数时后写覆盖，并由层权重控制覆盖程度。因此 Renderer 的更新顺序只能决定“谁覆盖谁”，
不能判断“难过时是否应该挥手”。

DesktopChar 采用同样的分层：

1. Live2D 更新管线继续负责 Motion、Expression、眨眼、视线和口型的参数所有权与最终覆盖顺序；
2. Character ExpressionCatalog 以 `blockedActionTags` 声明少量语义互斥，默认全部兼容；
3. ActionRuntime 在候选选择、队列真正启动前、表情切换后三个时点执行同一硬约束；
4. 新表情使当前动作失效时，Runtime 发出 `renderer.stop-motion`，清除同类排队动作，再允许兼容动作调度；
5. `mode: required` 只跳过概率门，不跳过表情、场景、姿态、说话状态等硬约束。

兼容配置放在表情侧，是因为当前关系是“多数表情兼容、少数表情禁止一类动作”的稀疏矩阵。
动作目录只需维护稳定的 `semanticTags`，不会随着表情数量增长而复制反向列表。若未来某个 Motion
拥有不可被 Expression 覆盖的完整面部演出，再单独在动作侧增加参数所有权策略，不与语义互斥混用。

## 概率、权重与硬条件

以下概念不能混用：

- 资产和场景适用性是硬性准入条件，不满足时动作不能进入候选集；
- `mode: required` 表示该事件不做概率抽签，但仍受资源存在、姿态、冲突和调试锁定等安全条件约束；
- `chance` 是一次明确触发机会中的触发概率；
- `weight` 是多个已合格候选之间的相对选择权重；
- `triggerChanceMultipliers` 是场景对某类触发机会的倍率；例如默认桌面场景将
  `conversation.completed` 设为 `3`，不影响常规待机机会；
- `priority` 决定优先级和是否允许替换低优先级动作。

候选权重抽样与命中概率抽样必须使用两个互相独立的随机值。复用同一随机值会把“选中了哪个候选”
和“该候选能否通过概率门”错误关联，使部分动作永远不可达。随机值和当前时间由调用事件携带，
Reducer 内不得读取随机数或系统时钟。概率只能在一次 `action-opportunity` 上计算一次，不能
逐帧抽取，否则低概率事件会随帧数快速趋近必然发生。

## 统一筛选与播放流程

1. 将外部输入转换为 ActionIntent；
2. 按准确 `actionId` 或语义标签建立候选集；
3. 依次过滤 binding、场景、姿态、Runtime 状态、说话兼容性、当前表情禁用标签、冷却和重复限制；
4. 优先处理 `required` 候选；
5. 对可选候选执行一次概率门控，并在最高优先级层按权重选择；
6. 生成包含上下文 revision 和已解析 binding 的不可变请求；
7. 根据忙碌策略立即播放、排队、替换或忽略；
8. 真正开始前再次验证当前场景与表情；
9. 由 Renderer 的真实生命周期事件推进队列；
10. 完成、失败或中断后更新历史，再调度下一个请求。

目录热重载采用完整校验、原子替换和 last-known-good 回退。已经开始的动作继续使用请求中冻结的
binding，新目录只影响后续选择，避免播放中途因配置变化换成另一项资源。
