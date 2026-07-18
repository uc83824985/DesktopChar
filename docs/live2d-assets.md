# Live2D 测试资源与版本固定

## 当前测试组合

- 模型：Mao，来自 Live2D 官方 `CubismWebSamples/Samples/Resources/Mao`。
- 上游分支：`develop`，提交 `b1de66b0b1f1cb881d95fb6158622aeb6a2827bd`，拉取日期 2026-07-18。
- Cubism Core：官方托管的 Cubism 5.2 路径 `https://cubism.live2d.com/sdk-web/core/05/live2dcubismcore.min.js`。
- Web 适配层：`pixi-live2d-display@0.4.0` + `pixi.js@6.5.10`。

没有使用 `Latest` Core。实测 Cubism 5.3 Core 与当前 Web 适配层在绘制 Mao 时不兼容；固定 5.2 后真实 Edge/WebGL 冒烟测试通过。升级 Core 或渲染框架必须重新运行 `npm run test:smoke`。

## 许可边界

Mao 在 Live2D 官方仓库的 `LICENSE.md` 中列为 Free Material License 模型；Cubism Core 属于 Live2D Proprietary Software License，并在官方 `RedistributableFiles.txt` 中列为可再分发文件。项目保留了上游 `LIVE2D_LICENSE.md` 和 `LIVE2D_NOTICE.md`。

使用或分发前仍需由使用者确认自身场景符合 Free Material License、Sample Model Terms、Proprietary Software License，以及商业主体是否需要 Cubism SDK Release License。本说明不构成法律意见。

## 更新流程

1. 更新 `references/CubismWebSamples` 官方浅克隆并记录提交。
2. 对比模型文件与上游许可变化。
3. 仅从 Live2D 官方下载页或官方托管 URL 获取 Core。
4. 执行 `npm run check`、`npm audit --omit=dev`、`npm run test:smoke`。
5. 三项全部通过后再更新固定版本。
