# Live2D Desktop Character

二次元 AI 桌面角色的首版工程骨架。项目采用“桌面壳 + 表演运行时 + Live2D 渲染适配器 + TTS MCP 适配器”的分层结构，参考仓库仅用于理解实现边界，不作为源码依赖。

## 模块

- `apps/desktop`：Electron 主进程、preload 安全桥与渲染进程装配。
- `packages/contracts`：跨模块事件、命令和领域类型，禁止依赖具体 UI 或渲染库。
- `packages/avatar-runtime`：状态机、表演规划、Timeline 和多层参数合成。
- `packages/live2d-renderer`：Live2D/Pixi 薄适配层。
- `packages/audio-runtime`：真实播放时钟与口型数据源。
- `packages/tts-mcp-adapter`：把已有 TTS MCP 输出规范化为可播放音频。
- `packages/transport`：桌面端内部及可选后端之间的消息传输。
- `packages/config`：角色、模型、动作白名单和运行时配置。

详细设计见 [docs/architecture.md](docs/architecture.md)。

## 当前进展

Avatar Runtime 的前两个阶段已实现：

- 事件驱动 contracts、只读 Snapshot、Runtime Effect 与 generation 隔离；
- Planner、播放时钟驱动的 Timeline、分层 Parameter Mixer；
- Fake TTS/Player/Renderer 驱动的端到端纵向闭环；
- TTS 乱序完成后的顺序播放、暂停/恢复、中断、失败跳过与能力降级测试。

当前仍未接入真实 Electron、Live2D 渲染库或 TTS MCP。运行检查：

```bash
npm install
npm run check
```
