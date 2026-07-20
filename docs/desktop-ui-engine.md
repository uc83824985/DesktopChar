# 桌面 UI 引擎层设计

## 结论

桌面 UI 不应是一组写死在 Electron renderer 中的字幕、聊天框或状态按钮。Scene Actor 只声明框架无关的 `UiSurface`：由哪个应用 presenter 渲染、处于哪个显示层、是否接收输入、事件如何映射回 Actor，以及 presenter 所需的纯数据配置。Scene Runtime 在同一个 revision 的 `scene.render-frame` 中同时输出世界绘制项和 UI Surface，避免画面已经切换场景而 UI 仍停留在旧状态。

具体 React、Vue、DOM、Canvas 组件属于应用层注册表。Presenter 只能读取 Frame 中冻结的 Actor state、Behavior mode、transform 和 config；交互必须通过 `routeSceneUiEvent()` 转换为带 generation 的 `actor.interacted` 事实，不能直接修改 Actor 或 Runtime。

## 参考项目结论

| 参考项目 | 可复用设计 | 不采用的部分 |
| --- | --- | --- |
| Open-LLM-VTuber-Web | Background、Live2D、Subtitle、连接状态和 Footer 的明确视觉分层；window/pet 两种组合模式；UI 小组件与 hooks 分离 | AI state、字幕、VAD、配置等由多个 React Context 分别持有；布局和具体组件直接写在 App；UI setter 可直接改变业务状态 |
| NagaAgent | `ball / compact / full` 原生窗口模式；renderer 用 `ResizeObserver` 测量内容后请求 main 调整 bounds；装饰层使用 `pointer-events: none` | 单个 `FloatingView.vue` 同时负责网络、聊天、通知计时器、窗口命令、拖动和布局；窗口模式及业务按钮固化在组件内 |
| CubismWebSamples | Live2D Canvas 生命周期和坐标处理 | 没有通用桌面 UI、动态场景 UI 或状态投影机制 |

因此当前设计只吸收三点：显示层分离、窗口形态可切换、内容测量作为 renderer 事实回传。参考项目中的组件级业务状态所有权不进入引擎。

## 数据流与所有权

```text
Scene/Avatar/Application facts
  -> Runtime transaction / behavior mode
  -> immutable SceneSnapshot
  -> one SceneRenderFrame revision
       |- drawItems
       `- uiSurfaces
  -> application presenter registry
  -> DOM/Canvas UI
  -> routeSceneUiEvent(surface, event, data)
  -> actor.interacted(generation, actorId, interaction)
  -> Runtime
```

UI 可以根据状态动态变化，但变化来源必须是新的 Runtime Frame。Presenter 内部允许有焦点、hover、滚动位置等短生命周期表现状态；场景模式、是否显示、业务进度、字幕内容、播放状态等可观察业务状态必须来自 Runtime/Actor state。

## UiSurface 契约

每个 `SceneActorDefinition` 可以声明多个 `uiSurfaces`：

- `id`：Actor 内唯一，运行时实例 id 为 `actorId:surfaceId`；
- `presenter`：应用层注册表键，不是模块路径或可执行脚本；
- `layer`：`world-underlay`、`world-overlay`、`screen-overlay` 或 `modal`；
- `order`：同层稳定排序，Actor/surface id 作为最终确定性 tie-breaker；
- `input`：`pass-through`、`surface` 或 `modal`；
- `events`：renderer 事件名到 Actor interaction 名的纯数据映射；
- `config`：应用 presenter 的静态、可序列化配置。

Frame 中的 `SceneUiSurfaceInstance` 另外携带 Actor state、Behavior mode 和已解析世界 transform。Actor 不可见时，其颜色部件和 UI Surface 会在同一 revision 一起消失；Fragment 装卸也自动获得相同生命周期。

### 显示层语义

| Layer | 用途 | 输入建议 |
| --- | --- | --- |
| `world-underlay` | 与 Actor 绑定、位于世界内容下方的标签或底板 | 通常 `pass-through` |
| `world-overlay` | Actor 气泡、局部提示、场景内控件 | `pass-through` 或 `surface` |
| `screen-overlay` | 与 viewport 绑定的状态条、字幕、工具入口 | `pass-through` 或 `surface` |
| `modal` | 明确阻塞其他交互的确认或授权界面 | 必须使用 `modal` input |

`pass-through` Surface 不能声明事件。Modal layer 与 modal input 必须同时出现，避免视觉上遮挡全局但窗口仍把点击穿透到底层桌面。

## 窗口和命中边界

Scene UI 引擎不直接调用 Electron：

- UI 内容尺寸变化由 presenter 产生测量事实，可映射为 Actor interaction，再由应用 Behavior 调用窗口布局 capability；
- main 继续独占原生 bounds、位置、置顶和穿透状态；
- renderer 合并可交互 UI Surface 命中与 Scene Coverage/Picking，再向 main 提交最终穿透布尔值；
- 装饰 UI 使用 `pass-through`，不应让角色包围盒重新变成整块可交互区域。

这保留了 NagaAgent 内容测量的有效流程，同时避免 UI 组件直接持有窗口状态。

## 当前完成范围

已完成：

- UiSurface 定义、默认 Actor 装配和结构校验；
- 与世界 draw items 同 revision 的确定性 UI 投影；
- Actor state、Behavior mode、transform 和 presenter config 输入；
- generation-safe UI 事件路由；
- 动态状态更新、Actor 隐藏、层级排序和非法声明的测试。

尚未实现具体应用 presenter、DOM host、UI 与像素 Picking 的合并，以及根据内容测量修改窗口 bounds。这些属于下一阶段的 renderer/application adapter，不在引擎中创建任何具体字幕、聊天框或场景 UI。
