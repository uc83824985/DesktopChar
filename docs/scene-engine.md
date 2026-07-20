# Scene Engine 抽象设计

## 结论

床、书籍、桌面物件、播放器表面等都不应成为引擎内置类型。引擎只提供可组合的 `SceneActor + Component + Slot + Relation + Behavior + RenderPart`，具体对象、资源、交互语义和随机事件由应用层声明。这样新增一个场景不需要修改引擎枚举，也不会把 `SeatAnchor`、`TelevisionActor` 或某个具体行为固化进底层。

当前只实现纯数据 Runtime、关系求解、渲染计划和测试，不包含任何具体场景、模型资源或前台入口。

## 引擎层与应用层边界

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| Scene Runtime | Actor/Relation 状态、generation、原子事务、Fragment 生命周期、行为路由 | 某种家具或物品是什么、何时选择某个剧情 |
| Scene Render Plan | Color/Depth/Coverage/Picking 描述、RenderPart 顺序约束、Pass 依赖 | Pixi/WebGPU 的具体绘制命令、业务点击含义 |
| Behavior Registry | 将受控事件转换为通用状态操作和 Capability Effect | 在场景 JSON 中携带可执行代码 |
| 应用层 | Actor 定义、资源引用、Behavior 实现、场景/Fragment/Scenario 选择 | 绕过 Runtime 直接改 Actor 状态 |
| Renderer/窗口层 | 执行 Render Frame、生成 Coverage/Picking、回传交互事件 | 持有权威场景状态或自行触发业务行为 |

Runtime 仍是状态唯一所有者。UI、拾取器、调度器和播放器只发送带 `generation` 的事实事件；Renderer 和应用能力适配器只执行 Runtime 下发的 Effect。

## 核心数据模型

### Actor 与 Component

`SceneActorDefinition` 是场景中的通用实体，包含：

- `transform`：2.5D 位姿，其中 `rotationZ` 使用弧度；
- `state`：Runtime 持有的可序列化状态；
- `components`：应用自定义的纯数据组件；
- `capabilities`：可被行为调用的能力名；
- `slots`：供其他 Actor 挂接、占用和插入渲染层次的位置；
- `renderParts`：一个或多个独立颜色/深度/交互表面；
- `behavior`：行为注册表中的类型、当前模式和配置引用。

Actor 定义没有函数。应用将实现注册到 `SceneRuntime.registerBehavior()`，Behavior 只能读取冻结的 Snapshot，并返回通用 `SceneOperation` 或 Capability Invocation。这使自定义逻辑可扩展，同时不破坏状态所有权和事务边界。

### Slot 与 Relation

Slot 只是带局部位姿、容量、标签和可选 Render Band 的通用空间。业务关系通过 `SceneRelation.participants` 的角色名表达，不在引擎中增加“座位”“桌面”之类的类型。

Relation 的约束会被实际执行：

| 约束 | 引擎保证 |
| --- | --- |
| `bind-transform` | Actor 的世界位姿跟随目标 Actor 或 Slot；拒绝多重父级和环 |
| `reserve-slot` | 统计占用并拒绝超过 Slot 容量的事务 |
| `insert-render-band` | 将 Actor 的 RenderPart 放在宿主指定部件之间 |
| `require-capability` | 关系建立前验证参与者能力 |
| `destroy-with` | 所有者销毁时级联销毁从属 Actor |

对象从一个位置移动到另一个位置时，应在同一事务内移除旧 Relation、建立新 Relation。外部只能观察到一次 revision 变化，不会看到对象短暂处于两个位置或无位置的中间状态。

### Scene、Fragment 与 Scenario

- `SceneDefinition`：原子替换的基础场景；替换会递增 generation，旧异步事件失效。
- `SceneFragmentDefinition`：可原子装载/卸载的一组 Actor 和 Relation，适合可选场景内容。
- `SceneScenario`：应用层可根据用户事件、空闲事件或其他事实选择的一组操作。
- `selectSceneScenario()`：只做优先级、冷却和加权选择，随机值与时钟由调用方注入，因此测试可重复。

主动触发和自动触发最终都变成同一种 Runtime Event。场景选择策略属于应用层；Scene Runtime 只验证并提交选择结果。

## 行为模式与交互

待机、占用某位置、进入交互过程等表现差异统一表示为 Behavior `mode`，而不是在引擎内增加具体动作枚举。一次拾取的完整路径为：

```text
Coverage/Picking result
  -> actor.interacted(generation, actorId, interaction)
  -> registered Behavior
  -> SceneOperation[] + Capability Invocation[]
  -> atomic state commit
  -> Render Frame / actor.capability-command Effects
```

Capability Effect 用于连接 Avatar Runtime、媒体播放、网页表面或应用自定义适配器。Scene Runtime 只校验目标 Actor 声明了该能力，不理解命令的业务含义。

## 2.5D 渲染与遮挡

单一 Z Order 不能表达一个物体的不同部分同时位于角色前后。当前渲染契约采用三层信息：

1. `RenderPart`：资源可拆分时，分别输出明确的前/后部件；Slot 的 Render Band 给出稳定的部件顺序约束。
2. `DepthRepresentation`：资源难以拆分时，可使用 plane、box、ellipsoid、capsule、mesh 或 depth-map 近似深度；Live2D 角色也可由多个 proxy 组合。
3. `Coverage/Picking`：与颜色和深度分离，只有显式开启交互的可见部件才分配 picking id。后续渲染器可以对鼠标附近异步读回，而无需每帧回读完整缓冲。

`buildSceneRenderFrame()` 输出数据化 Pass DAG：Actor 表面生成、世界深度合成、Coverage/Picking、最终叠加。它类似 Render Graph 的声明，不绑定某一个图形 API；当前阶段没有执行 GPU 绘制。

## 原子性和失败规则

- Scene 替换、事务、Fragment 装载和卸载均先在副本上完整校验，再一次提交。
- 非法深度、未知 Actor/Slot、容量溢出、缺失能力、Transform 环和 Render Band 环都拒绝提交。
- Scene 替换递增 `generation`；迟到的交互、行为事件和事务直接忽略，即使新场景复用了相同 Actor id。
- Behavior 产生的操作和 Capability Invocation 会一起预校验；操作失败时不发送能力 Effect。
- Snapshot 深度冻结；应用和 Renderer 不能通过引用修改 Runtime 状态。

## 当前测试覆盖

`packages/scene-runtime/test` 使用匿名 Actor 和通用能力覆盖：

- Slot 挂接后的世界位姿与容量拒绝；
- 对象跨 Slot 原子转移；
- 交互驱动 Behavior 模式变化并调用另一个 Actor 的能力；
- Scene generation 隔离迟到事件；
- Fragment 原子装载/卸载；
- 拆分部件的前后插入、未拆分对象的 box depth proxy；
- Coverage/Picking opt-in 与不可见部件剔除；
- 非法深度和 Transform 环拒绝；
- Scenario 的优先级、冷却和确定性加权选择。

这些测试覆盖了已提出场景背后的共性机制，但仓库中没有创建任何具体场景或业务 Actor。
