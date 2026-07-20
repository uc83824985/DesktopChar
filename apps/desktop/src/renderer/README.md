# Renderer process

负责画布、桌面交互和模块装配。UI 通过领域接口控制 Avatar，不直接访问 Live2D SDK 私有成员。

桌面模式将全局指针换算为窗口局部坐标，并在最终 Pixi 帧上查询该位置的像素 alpha。只有实际可见像素会请求 main 恢复窗口交互；透明像素保持穿透。WebGL2 使用单像素 PBO + fence 异步回读，WebGL1 降级为同步读取一个 RGBA 像素。模型 `HitAreas` 只用于给点击附加语义标签，不再决定是否命中。

点击只发送 Runtime Event，拖动只请求 main 更新窗口 bounds。拖动开始后由 pointer capture 和 main 的 drag state 锁定交互，迟到的像素读取不能中断拖动。
