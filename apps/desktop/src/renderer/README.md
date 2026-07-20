# Renderer process

负责画布、桌面交互和模块装配。UI 通过领域接口控制 Avatar，不直接访问 Live2D SDK 私有成员。

桌面模式将全局指针换算为窗口局部坐标，通过模型 `HitAreas` 请求 main 切换鼠标穿透；点击只发送 Runtime Event，拖动只请求 main 更新窗口 bounds。
