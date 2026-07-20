# Live2D Desktop Character

事件驱动的 AI 桌面角色运行时。Avatar Runtime 是状态唯一所有者；UI、播放器和渲染器只发送事实事件或执行 Runtime Effects。

## 模块

- `apps/desktop`：Electron main/preload/renderer 与可复用的浏览器前台测试壳。
- `packages/contracts`：跨模块事件、效果和领域类型。
- `packages/avatar-runtime`：状态机、Planner、Timeline 与 Parameter Mixer。
- `packages/live2d-renderer`：模型无关端口、生命周期和 Live2D 适配边界。
- `packages/audio-runtime`：真实播放时钟接口。
- `packages/tts-mcp-adapter`：TTS MCP 输出适配。
- `packages/transport`、`packages/config`：传输和配置边界。

详细设计见 [架构文档](docs/architecture.md) 和 [Avatar Runtime](docs/avatar-runtime.md)。

角色级视线校准及资源修改边界见 [GazeProfile 工作流](docs/gaze-calibration.md)；透明区穿透、角色点击/拖动和窗口包围盒同步见 [透明桌面悬浮壳](docs/desktop-shell.md)。

TTS Mock、流式 MCP/HTTP 绑定和真实服务接入契约见 [TTS Adapter 文档](docs/tts-adapter.md)；Qwen3-TTS 当前公开推理接口的流式能力核对见 [Qwen3-TTS 阅读记录](docs/references/qwen3-tts.md)。

## 一键前台测试

安装 Node.js 24 后，在仓库根目录执行：

```bash
npm install
npm start
```

浏览器会自动打开 `http://127.0.0.1:5173`。看到“Runtime 已就绪”后，可测试模拟说话、动作事件和鼠标视线跟随。UI 只向 Runtime 提交事件，模型参数由 Runtime Effects 驱动。

“口型同步验收”会播放一段先验已知的三段式 PCM 提示音，实时显示播放端、Mao 嘴部参数和 Pixi 渲染帧的响应时差，并将这些时差纳入自动验收；规则见 [先验铃声流与口型时点验收](docs/audio-lip-sync-acceptance.md)。

## 一键桌面悬浮测试

```bash
npm run desktop
```

这会构建并启动透明置顶角色。透明区域保持点击穿透；Mao 的头部和身体可左键点击或拖动，右键可恢复默认位置或退出。角色拖动直接移动原生窗口，窗口包围盒与显示位置同步更新。

## 验证

```bash
npm run check
npm run diagnose:tts
npm audit --omit=dev
npm run test:smoke
npm run test:desktop-smoke
```

`test:smoke` 在 Windows Edge 中实际加载 Core、Mao 模型和纹理，并操作三个前台按钮；`test:desktop-smoke` 另外启动真实 Electron 窗口验证透明、置顶、穿透、拖动和 bounds 同步。首次启动前请阅读 [Live2D 资源与许可说明](docs/live2d-assets.md)。
