# 透明桌面悬浮壳设计

## 当前方案

首版使用一个与角色显示区域同尺寸的无边框透明 Electron `BrowserWindow`。角色移动等价于移动原生窗口；窗口自身没有单独的“角色局部坐标”，因此显示位置、点击坐标和原生窗口包围盒不会逐渐漂移。

```text
OS 全局指针（DIP）
        |
 Electron main 每 33ms 采样
        |
        v
renderer: screen point -> window local point -> Live2D hitTest
        |                                      |
        | miss                                 | hit
        v                                      v
setIgnoreMouseEvents(true, forward)    可点击 / 可拖动角色
桌面收到点击                           UI 只发送 user.avatar-clicked
```

窗口固定透明、置顶、无任务栏图标，默认位于主屏工作区右下角。拖动使用屏幕坐标计算新的 `BrowserWindow` bounds，并将完整窗口限制在距离最近显示器的工作区内。main 在每次 move/resize 后把 bounds 回传 renderer；renderer 只用它做坐标换算和诊断，不自行保存第二份窗口位置状态。

## 点击与拖动

- 指针不在 Live2D `HitAreas` 内：整个窗口临时进入鼠标穿透，点击落到原桌面应用。
- 指针进入角色 `HitAreas`：恢复窗口交互，可左键点击或拖动。
- 位移小于 5 DIP：解释为角色点击，向 Runtime 发送 `user.avatar-clicked`。
- 位移达到 5 DIP：解释为拖动，仅更新原生窗口位置，不修改 Avatar 状态。
- 角色上右键：显示“恢复默认位置 / 退出”原生菜单。

Mao 资源定义了 `Head` 和 `Body` 两个 HitArea，因此头部和身体均可交互。这里的命中测试是模型作者定义的可点击网格区域，不是纹理逐像素 alpha 测试。

## 实现方案差异

| 方案 | 桌面交互 | 角色点击 | 主要代价 |
| --- | --- | --- | --- |
| 大面积透明窗口始终可交互 | 透明区域也会挡住桌面 | 最简单 | 不满足桌面角色“不打扰”目标 |
| 整窗永久穿透 | 完全不挡桌面 | 不可点击、不可拖动 | 只能依赖托盘、快捷键等外部入口 |
| 按 HitArea 动态切换整窗穿透（当前） | 透明区点击落到桌面 | 角色区域可点击、可拖动 | 指针进入时需要一次命中检测和模式切换 |
| 原生 `setShape` 裁切窗口 | 形状外天然不接收点击 | 形状内可点击 | 平台差异明显，动画网格需频繁重建矩形区域，难以做像素级轮廓 |
| 全屏透明 overlay | 方便做全桌面特效 | 需同样实现动态穿透 | 更容易误拦截桌面，当前无必要 |

当前方案同时满足透明区域穿透和角色可点击。若未来要让“所有可见像素”可点击，应在 renderer 增加基于 drawable 几何/alpha 的命中适配器；不应退回整块矩形可点击，因为那会重新吞掉角色轮廓内的大量透明点击。

## 进程与安全边界

- main 独占窗口创建、bounds、置顶、鼠标穿透和原生菜单。
- preload 在 `contextIsolation + sandbox` 下只暴露固定 IPC，不暴露 Node 或原始 `ipcRenderer`。
- renderer 只发送屏幕点、穿透布尔值和菜单意图；main 校验 IPC sender 和参数。
- 正式构建通过安全的 `desktop-char://app/` 自定义协议读取本地产物。
- 开发 URL 只允许 `http://127.0.0.1`、`localhost` 或 IPv6 loopback，禁止把有 Node 桥的窗口导航到远程页面。
- 页面 CSP 禁止 `unsafe-eval`；Pixi 使用兼容 CSP 的 shader compiler。

## 启动与验收

```bash
npm run desktop
npm run test:desktop
npm run test:desktop-smoke
```

`npm run desktop` 会先构建再启动透明悬浮窗口。自动烟雾测试会验证窗口透明/置顶/尺寸、初始穿透、拖动后原生 bounds，以及 renderer 收到的 bounds 是否一致。
