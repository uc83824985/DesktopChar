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

## Web 与桌面共享实现

网页前台与 Electron 桌面端应复用同一套 DOM UI 实现，而不是分别维护场景 UI。共享部分为 `scene-ui-dom` renderer/application adapter；它消费 `SceneRenderFrame.uiSurfaces`，但不持有 Scene Runtime 的业务状态。

```text
scene-runtime
  `- SceneRenderFrame.uiSurfaces
              |
              v
scene-ui-dom
  |- PresenterRegistry
  |- DomUiHost
  |- UiEventBridge
  `- shared presenters/styles
              |
       +------+------+
       |             |
       v             v
 Web test host   Electron host
 normal DOM      DOM + native window capabilities
```

共享 adapter 的职责为：

- `PresenterRegistry` 将 Surface 的 `presenter` 键映射到应用注册的 DOM presenter；
- `DomUiHost` 按实例 id 增删和更新节点，并分别挂载到 `world-underlay`、`world-overlay`、`screen-overlay`、`modal` 容器；
- `UiEventBridge` 使用 `routeSceneUiEvent()` 将 DOM 事件转换为 Runtime 事实事件；
- `pass-through` 节点使用 `pointer-events: none`，`surface` 和 `modal` 节点才参与输入；
- presenter 只允许保存 hover、focus、scroll 等瞬时 UI 状态，不得保存字幕、播放、场景进度等业务事实。

Electron 专属能力不进入 `scene-ui-dom`。桌面宿主在共享 DOM Host 之外负责透明窗口穿透、屏幕坐标转换、内容尺寸到窗口 bounds 的反馈，以及将 UI 命中与角色/场景 Coverage 命中合并：

```text
windowInteractive = characterCoverageHit
                 || sceneActorHit
                 || interactiveUiSurfaceHit
```

普通网页无需原生窗口穿透和 bounds 管理，但 Surface 投影、层级、事件路由及 presenter 行为必须与桌面端保持一致。这样网页前台可以作为快速集成与回归环境，Electron 只增加宿主能力，不形成另一套 UI 业务实现。

### 现有网页测试页迁移策略

当前网页页面是 TTS、口型、动作、凝视和播放时点的测试夹具，不是最终应用 UI，因此不进行整体重构。接入 `scene-ui-dom` 时保留现有按钮和诊断日志，并新增一个最小 Scene UI 样例，覆盖：

- presenter 注册、节点创建和 Runtime Frame 驱动的动态更新；
- Surface 显隐、四种 layer 的稳定顺序；
- DOM 事件经 `actor.interacted` 回到 Runtime；
- `pass-through` 与交互 Surface 的命中差异；
- 模型 draw items 与 UI Surface 使用同一 Frame revision。

正式字幕、状态提示、快捷操作等用户 UI，等应用层需求稳定后再逐项迁移为共享 presenter。届时共享 Runtime/renderer bootstrap 之上保留两种组合入口：测试页继续装配诊断夹具，实际 Web/Electron 应用装配 Presenter Registry 和产品 UI；测试夹具不进入产品 Scene UI 契约。

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
- `scene-ui-dom` 的即时 UI 注册表和共享 DOM 右键菜单 Host；
- 角色、聊天气泡诊断和桌面窗口分别主动注册菜单贡献，菜单打开时重新读取当前 Runtime 状态；
- 键盘 `Shift+F10` / Context Menu 键入口、菜单焦点导航，以及 Electron 穿透状态合并；
- 动态状态更新、Actor 隐藏、层级排序和非法声明的测试。

尚未实现通用 `SceneRenderFrame.uiSurfaces` DOM Host、聊天气泡的 Actor 锚点定位，以及根据内容测量修改窗口 bounds。右键菜单已先验证共享 Host、对象注册、即时状态投影和 Electron 命中合并；后续场景 Surface 复用同一 package，不在引擎中创建任何具体字幕、聊天框或场景 UI。

### 开发期即时 UI 注册

`ImmediateUiRegistry` 提供类似 ImGui 的声明方式，但注册主体仍遵守 Runtime 单一状态所有权：

```ts
registry.register({
  id: 'book.debug-settings',
  target: 'book',
  build: () => ({
    label: '书籍',
    items: [{
      type: 'action',
      id: 'read',
      label: '触发阅读',
      invoke: () => sceneRuntime.dispatch({ /* actor event */ }),
    }],
  }),
});
```

- 对象注册的是纯声明 provider，不创建、缓存或持有 DOM；
- `build()` 在每次打开时执行，checkbox、enabled 等状态来自最新 Runtime Snapshot；
- 菜单保持打开时，Runtime subscriber 会调用 Host `refresh()`；Host 对不含回调函数的声明签名去重，仅在 checked、enabled、label 或结构实际变化时更新 DOM；
- checkbox 默认保持菜单打开并立即重投影，普通 action 仍按上下文菜单习惯在触发后关闭；
- item 回调只能发送 Runtime 事件或调用应用授予的 capability；
- 注册返回 disposer，对象卸载时可同步撤销 UI；
- `target: '*'` 用于桌面窗口等全局贡献，多个对象贡献按 `order + id` 确定性合并。

当前角色右键菜单包含可勾选的眼部跟随、三种聊天气泡测试、两端 MCP 动态启停/连接测试/配置重载、隐藏角色、恢复窗口位置和退出；“恢复中立”不再作为容易与跟随状态混淆的一次性按钮。MCP checkbox 投影 Electron main 的服务状态并只发送异步命令，不在 DOM 中保存连接事实。菜单展开期间作为交互 Surface 暂停窗口穿透，关闭后重新回到像素 Coverage 决定的状态。隐藏角色只是向 Electron shell 发送白名单命令，托盘及窗口显隐仍由 main 独占。

### 已落地的应用 presenter：聊天气泡

现有 renderer 已装配第一个只读应用 presenter：角色聊天气泡。它读取 Avatar Runtime 的活动 segment 与播放快照，通过纯函数投影完整、渐进追加和 KTV 高亮状态；不进入 Scene Engine 内置类型，也不在 DOM 中持有计划或播放进度。当前为 `scene-ui-dom` 落地前的应用装配验证，后续只迁移 Host 和角色锚点定位，保留领域契约。详见 [角色聊天气泡](speech-bubble.md)。
