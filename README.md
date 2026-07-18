# Live2D Desktop Character

事件驱动的 AI 桌面角色运行时。Avatar Runtime 是状态唯一所有者；UI、播放器和渲染器只发送事实事件或执行 Runtime Effects。

## 模块

- `apps/desktop`：当前浏览器前台测试壳，后续承载 Electron main/preload/renderer。
- `packages/contracts`：跨模块事件、效果和领域类型。
- `packages/avatar-runtime`：状态机、Planner、Timeline 与 Parameter Mixer。
- `packages/live2d-renderer`：模型无关端口、生命周期和 Live2D 适配边界。
- `packages/audio-runtime`：真实播放时钟接口。
- `packages/tts-mcp-adapter`：TTS MCP 输出适配。
- `packages/transport`、`packages/config`：传输和配置边界。

详细设计见 [架构文档](docs/architecture.md) 和 [Avatar Runtime](docs/avatar-runtime.md)。

## 一键前台测试

安装 Node.js 24 后，在仓库根目录执行：

```bash
npm install
npm start
```

浏览器会自动打开 `http://127.0.0.1:5173`。看到“Runtime 已就绪”后，可测试模拟说话、动作事件和鼠标视线跟随。UI 只向 Runtime 提交事件，模型参数由 Runtime Effects 驱动。

## 验证

```bash
npm run check
npm audit --omit=dev
npm run test:smoke
```

`test:smoke` 在 Windows Edge 中实际加载 Core、Mao 模型和纹理，并操作三个前台按钮。首次启动前请阅读 [Live2D 资源与许可说明](docs/live2d-assets.md)。
