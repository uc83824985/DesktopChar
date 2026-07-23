# 角色视线校准工作流

## 结论

`GazeProfile` 负责把 Runtime 的标准化目标 `[-1, 1]` 映射为某个角色实际使用的头部和眼球参数。它适合修正输入灵敏度、中心死区、正负方向响应曲线和视觉平衡，但不能创造模型资源中不存在的形变。

因此采用两级流程：先调角色配置，再在确实触及资源上限时修改 Live2D 资源。不要把某个模型的补偿常量写入 Runtime，也不要一开始就直接修改原始模型。

## 角色级配置

每个轴的正、负方向分别定义端点和曲线：

```ts
interface GazeAxisProfile {
  negative: { limit: number; exponent: number };
  positive: { limit: number; exponent: number };
  deadZone: number;
}

interface GazeProfile {
  headX: GazeAxisProfile;
  headY: GazeAxisProfile;
  eyeX: GazeAxisProfile;
  eyeY: GazeAxisProfile;
  smoothing: {
    headResponseMs: number;
    eyeResponseMs: number;
  };
}
```

- `limit`：输入到达该方向端点时写入的模型参数值；可用于限制较强的一侧。
- `exponent < 1`：较小输入更快产生明显响应。
- `exponent > 1`：中心区域更缓和，靠近边缘才快速响应。
- `deadZone`：抑制中心附近的鼠标抖动。
- `headResponseMs`：头部完成目标变化 90% 所需时间。
- `eyeResponseMs`：眼球完成目标变化 90% 所需时间；通常应短于头部。

鼠标位置只提供标准化参考目标，不决定动画推进频率。Runtime 同时持有参考目标和当前呈现值，并由显示帧的 `deltaTime` 推进帧率无关的插值；映射结果仍通过 Gaze 参数层进入 Mixer，UI 不能直接写模型参数。重复提交相同参考点不会重启或改变插值曲线。

## 校准步骤

1. 读取模型参数范围、默认值、关键点和 `HitAreas`，确认参数 ID 与方向符号。
2. 暂停随机 idle/motion，以 `-1、-0.5、0、0.5、1` 的标准输入采集头部和眼球表现。
3. 先调 `deadZone`，再分别调正负方向 `exponent`，最后限制视觉过强方向的 `limit`。
4. 恢复 idle、physics、表情、动作和说话，验证 Gaze 层的最终所有权以及组合表现。
5. 对每个角色保留端点、半程和中心回归测试；切换模型时只替换配置。

## 何时必须修改资源

出现以下情况时，继续调 Profile 已不能解决，需要在 Cubism Editor 中修改参数关键形或相关 Deformer：

- 参数已到模型最大值，但抬头幅度仍不足；
- 上下方向的轮廓、透视或遮挡关系不自然，而不只是幅度不同；
- 眼球、眼睑、头发或物理参数之间缺少所需联动；
- 需要扩大参数范围，或者现有关键形在端点发生破面。

资源修改后仍需重新跑 Profile 校准；Profile 是运行时适配层，不是资源质量修复层。

## Mao 当前判断

离线读取 `Mao.moc3` 后，`ParamAngleY` 和 `ParamEyeBallY` 的参数范围及关键点均为对称值；同幅输入下眼球网格变化基本对称，但头部向下的网格变化约为向上的 1.52 倍。因此弱抬头主要来自资源已制作形变不对称，不是 Runtime 方向映射错误。

当前 `models/Mao/DesktopChar.character.json` 的 `gazeProfile` 使用以下补偿：

- 向下头部端点限制为 `-20`，向上保留 `30`；
- 向上的 head/eye 曲线稍提前响应；
- 头部和眼球保留小死区以抑制指针抖动。
- 眼球以 `45ms`、头部以 `120ms` 的 90% 响应时间追踪参考点。

这会改善日常跟随的视觉平衡，但不会增强 `ParamAngleY = 30` 时的最大抬头形变。若仍希望端点明显抬高，应修改 Mao 资源，而不是继续增加 Runtime 参数值。

Live2D `motion3.json` 中的 `Fps` 是资源采样/导出信息，Cubism 会在每个显示帧按时间求值线性或贝塞尔曲线。除非资源明确使用 `Stepped` 段或存在低质量逐帧烘焙，不应为了提高屏幕刷新率而预处理动作资源。
