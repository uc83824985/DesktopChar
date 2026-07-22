# 配置所有权与 JSON 重构方案

## 结论

DesktopChar 不再把环境变量作为普通用户的主要调参入口。目标配置按所有权拆为三类 JSON：

1. **应用配置**：连接、交互、窗口默认值和表现层默认值，存放在 Electron `userData` 目录。
2. **角色资产配置**：模型入口、能力白名单、GazeProfile 和 LipSyncProfile，跟随角色资产目录分发。
3. **运行状态**：窗口位置、显隐状态、上次使用角色等由程序自动维护，不与用户配置混写。

三类数据都使用 JSON，但采用不同 schema、生命周期和写入权限。Avatar Runtime 仍是角色状态唯一所有者；读取配置不等于允许 UI、播放器或 Renderer 直接修改 Runtime 状态。

## 为什么资产使用独立 JSON

Live2D 的 `*.model3.json` 是 Cubism 资产清单，不应加入 DesktopChar 私有字段。每个角色在模型目录旁增加独立 sidecar：

```text
models/Mao/
  Mao.model3.json
  DesktopChar.character.json
  expressions/
  motions/
  Mao.2048/
```

`DesktopChar.character.json` 内的路径相对该文件解析，因此复制整个角色目录即可保留模型入口和校准参数。它复用应用配置所使用的 JSON 解析、版本检查、schema 校验和错误报告设施，但使用独立的 CharacterProfile schema。

不允许在资产 JSON 中注册任意脚本或模块路径。资产只能引用应用层已经注册的 emotion、action、behavior 和 presenter ID，避免下载一个模型时顺带获得代码执行能力。

当前 Mao 使用的结构如下：

```json
{
  "$schema": "../../schemas/desktop-char.character.schema.json",
  "version": 1,
  "id": "mao",
  "model": "Mao.model3.json",
  "defaultEmotion": "neutral",
  "allowedEmotions": ["neutral", "happy"],
  "allowedActions": ["nod"],
  "expressionCooldownMs": 500,
  "idleReturnDelayMs": 800,
  "gazeProfile": {
    "headX": {
      "negative": { "limit": -30, "exponent": 1 },
      "positive": { "limit": 30, "exponent": 1 },
      "deadZone": 0.02
    },
    "headY": {
      "negative": { "limit": -20, "exponent": 1 },
      "positive": { "limit": 30, "exponent": 0.9 },
      "deadZone": 0.02
    },
    "eyeX": {
      "negative": { "limit": -1, "exponent": 0.9 },
      "positive": { "limit": 1, "exponent": 0.9 },
      "deadZone": 0.01
    },
    "eyeY": {
      "negative": { "limit": -1, "exponent": 0.9 },
      "positive": { "limit": 1, "exponent": 0.85 },
      "deadZone": 0.01
    }
  },
  "lipSyncProfile": {
    "gain": 2.5,
    "attackMs": 30,
    "releaseMs": 180,
    "peakHoldMs": 25
  }
}
```

原先 `packages/config` 中硬编码的 `MAO_CHARACTER_CONFIG` 已迁移到该文件。`DESKTOP_CHAR_LIP_SYNC_GAIN` 也已退出常规配置入口，因为相同音频电平在不同模型上的嘴部表现是资产校准结果，而不是全局音频服务参数。

`LipSyncProfile` 的字段所有权如下：

| 字段 | 含义 | 当前 Mao 值 |
| --- | --- | ---: |
| `gain` | 原始播放电平到模型开口幅度的倍率 | 2.5 |
| `attackMs` | 张嘴完成 90% 响应所需时间 | 30 |
| `releaseMs` | 闭嘴完成 90% 响应所需时间 | 180 |
| `peakHoldMs` | 短电平峰值的保持时间 | 25 |

三个时间字段允许为 `0`，用于关闭对应过渡并进行直接电平映射诊断。旧角色 Profile 若只声明 `gain`，解析器会补全上述通用时间默认值；未知字段、负时间和非正 gain 会拒绝加载。

## 应用配置 JSON

仓库根目录的 `desktop-char.config.example.json` 继续作为可复制样例。开发期现有 `desktop-char.config.json` 保持兼容；产品打包后默认有效文件改为：

```text
${app.getPath('userData')}/config.json
```

Windows 通常对应 `%APPDATA%/DesktopChar/config.json`。程序只通过 Electron 返回的 `userData` 路径定位，不在代码中拼写平台目录。

当前支持的顶层结构：

```json
{
  "$schema": "./apps/desktop/public/schemas/desktop-char.config.schema.json",
  "version": 1,
  "interaction": {
    "drag": {
      "holdDelayMs": 180
    }
  },
  "window": {
    "defaultSize": { "width": 460, "height": 700 },
    "defaultMarginDip": 24,
    "alwaysOnTop": true
  },
  "agentHttp": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 17373
  },
  "character": {
    "profile": "models/Mao/DesktopChar.character.json"
  },
  "ttsMcp": {},
  "characterMcp": {}
}
```

以下当前可调项已经进入应用 JSON：

- 拖动长按延迟；
- Agent HTTP 启停、loopback host 和端口；
- 语音合成 MCP、角色接入 MCP、重连与内置本地语音合成参数；
- 窗口默认尺寸、边距、置顶策略等用户偏好；
- 当前角色资产 Profile 路径。

聊天气泡的全局默认显示/纯文本回退计时，以及后续增加的拖动距离阈值仍需先改造成可注入的 Runtime Policy，再加入 JSON；在完成该边界前不提供“写入了但没有实际生效”的字段。

`window.position`、当前显隐、当前菜单勾选、正在播放内容、Runtime snapshot 等不是“默认配置”，不会因为频繁运行状态变化反复改写用户配置文件。

## 读取、热重载与后续写入入口

Electron main 已独占配置控制器、有效 revision 和文件监听。设置 UI 的安全写入入口按下列链路实现：

```text
Settings UI --patch intent--> preload whitelist --> main validate
                                                   |
                                                   +--> temp file + atomic replace
                                                   +--> publish config revision
                                                            |
                                                            v
                                                 renderer -> Runtime event
```

- Renderer 不能直接读取或写入任意文件；后续设置页只能提交白名单字段的 patch intent。
- main 的后续 writer 合并 patch 后对完整文档做 schema 和语义校验，再用临时文件加原子替换提交。
- 非法 JSON 或非法值不会替换上一份有效 revision。
- 配置变更通过事件进入 Runtime，不能绕过 Runtime 直接写 Live2D 参数。
- 配置文件可记录 `version` 并在读取时执行显式迁移；未知的新版本拒绝加载，不静默猜测。

热重载按副作用分级：

- **立即应用**：拖动长按延迟和置顶策略。
- **Runtime 空闲边界应用**：语音 Provider 切换。
- **先建立候选端口再替换**：Agent HTTP；新 listener 建立失败时旧 listener 继续服务。
- **先关闭再重绑**：角色接入 MCP 的监听端口。
- **仅启动时读取**：配置文件位置、开发服务器 URL、原生拖动后端诊断选择。

角色 Profile 路径与 Profile 内容当前仍在 Renderer 初始化时读取，修改后需要重启应用。这是本轮迁移后的明确实现缺口，不是最终契约；下面的“效果参数运行时热重载”是后续参数接入必须满足的验收要求。

## 效果参数运行时热重载

JSON 的主要价值不只是替代环境变量，还要成为开发期和用户侧可观察、可验证的实时调参接口。凡是影响角色、场景、声音表现或输入手感的**效果参数**，都必须具有运行时重载路径；新增字段只有同时具备 schema、归一化、变更 diff、应用边界和自动测试，才算完成接入。

应用配置和当前角色 Profile 分别持有 revision：

```text
DesktopConfigController ----- app revision ----+
                                                |
CharacterProfileController -- asset revision ---+--> validate complete candidate
                                                       |
                                                       +-- invalid --> keep last-good revision
                                                       |
                                                       +-- valid --> typed config diff
                                                                       |
                                                                       v
                                                        Avatar Runtime config event
                                                                       |
                                                  +--------------------+-------------------+
                                                  v                    v                   v
                                           next Runtime tick      idle boundary      service transaction
```

- main/资产控制器监听应用 JSON 和当前激活的 `DesktopChar.character.json`；文件保存、原子替换和删除后的 fallback 都要产生可诊断结果。
- 每次先解析**完整候选快照**，完成 schema、语义、能力 ID 和资源路径校验后再递增 revision。禁止把半份 patch 逐字段写进当前运行状态。
- 相同规范化内容不递增 revision；连续保存通过防抖合并，但不能丢失最后一次有效内容。
- 非法候选保留 last-good revision、当前 Runtime 和正在播放的内容，同时向设置 UI/日志公开错误路径。
- main 只发布带 revision 的类型化配置事实。Renderer、播放器和 UI 不监听文件，也不能收到配置后直接篡改角色状态。
- Avatar Runtime 通过 `runtime.effect-config-revised` 一类事件接收配置，保存当前 effect revision，并按字段的应用策略更新内部 Policy。旧 revision 的异步结果不能覆盖新 revision。
- 纯参数更新不得重建 Avatar Runtime、清空计划、重置 gaze 开关、打断音频、重新创建窗口或使当前 Scene generation 失效。

角色右键菜单将手动入口放在独立的“应用配置 · rN”分区并命名为“重新加载配置”。它与自动监听调用同一加载事务，只提供立即复核、错误反馈和监听异常时的恢复路径；“MCP 服务”分区只保留两端启停与连接测试，避免把统一应用配置误表达为 MCP 私有状态。

效果参数按应用边界分级：

| 参数类别 | 示例 | 运行时应用规则 |
| --- | --- | --- |
| 帧级角色参数 | Gaze 端点/指数/死区、LipSync gain、表情权重、视线/嘴型平滑时间 | 校验后在下一个 Runtime tick 生效；从当前输出做短时平滑过渡，不能出现头眼或嘴型瞬跳。正在说话时修改 gain 也不重启播放。 |
| 表现层策略 | 聊天气泡显示速度、关闭延迟、KTV 样式、材质参数、Actor 显隐/渲染参数 | 状态类参数通过 Runtime/Scene 事务进入下一 revision；纯样式由对应 presenter 在下一 UI/Scene Frame 使用，不能反向持有领域状态。 |
| 输入手感参数 | 拖动长按/距离阈值、像素命中阈值与防抖、视线输入平滑 | 下一次交互开始时使用新 revision；已经处于 pending/dragging 的手势固定使用开始时的 revision，避免同一次手势中途改变判定。 |
| 新任务默认值 | TTS voice/rate/format、动作默认策略、聊天气泡默认模式 | 只作用于重载后创建的新 utterance/plan；正在合成或播放的 segment 继续使用它捕获的 revision。 |
| 结构性角色配置 | model/texture/motion 资源、能力白名单、参数 alias | 等待 Runtime idle，先建立候选模型并探测能力，再原子替换；失败回滚旧模型。不得在一句语音中途换模型。 |
| 服务与原生壳 | Agent/MCP endpoint、窗口默认尺寸、原生拖动 backend | endpoint 走可回滚的 listener/session 事务；默认尺寸用于新建/恢复窗口；配置路径、开发 URL 和诊断 backend 仍可标记为仅启动生效。 |

数值效果参数建议在 schema 中同时声明 `minimum/maximum` 和可选的 `transitionMs`。Runtime 记录过渡起始输出、目标 Profile 和 revision，以播放时钟/帧时钟插值；不允许 Renderer 自行读取 JSON 后突然覆盖最终参数。Gaze 与 LipSync 的默认过渡可分别从约 `120 ms` 和 `80 ms` 起步，再以前台验收结果校准。

每个可热重载字段都要在字段注册表中明确四项元数据：`owner`、`applyBoundary`、`transitionPolicy`、`restartRequired`。设置 UI 据此显示“立即生效”“下一句生效”“空闲后切换”或“重启后生效”，不能把所有保存结果都笼统显示为成功。

最低自动验收包括：

1. 鼠标静止且 gaze 持续运行时修改 GazeProfile，模型在预期帧数内平滑采用新曲线，Runtime generation 和 gaze 模式不变。
2. 先验音频播放期间修改 `lipSyncProfile.gain`，同一 PCM 电平按新增益平滑响应，播放 position、segment 和聊天气泡时间线不中断。
3. 修改拖动阈值时，当前手势保留旧 revision，下一次手势使用新值。
4. 修改 TTS 默认 voice/rate 时，当前 utterance 不变，下一句使用新 revision。
5. 写入非法值、未知字段或失效资源路径时 revision 不变，当前表现继续工作并返回精确错误。
6. 结构性模型切换失败时旧模型、Runtime snapshot 和窗口交互全部保留。

## 本轮暂不改为 JSON 的环境变量

以下变量在当前重构方案中继续保留为环境变量，因为它们负责在读取配置前定位应用、选择开发/诊断路径，或只服务自动化测试：

| 环境变量 | 保留原因 |
| --- | --- |
| `DESKTOP_CHAR_CONFIG_PATH` | 总配置路径引导；必须先知道路径才能读取 JSON。 |
| `DESKTOP_CHAR_MCP_CONFIG_PATH` | 现有 MCP 配置路径的兼容别名；后续加入弃用提示，最终由上一项取代。 |
| `DESKTOP_CHAR_DEV_URL` | Electron 开发服务器启动注入，不属于最终用户偏好。 |
| `DESKTOP_CHAR_DRAG_WINDOW_API` | `auto/native/setBounds` 原生窗口拖动后端诊断开关，不作为产品选项。 |
| `DESKTOP_CHAR_CHAT_BUBBLE_SCREENSHOT` | 聊天气泡截图测试输出路径。 |
| `DESKTOP_CHAR_CHAT_BUBBLE_STREAM_SCREENSHOT` | 流式聊天气泡截图测试输出路径。 |

仓库根目录的独立 `local-tts-mcp` 是 DesktopChar 之外也可启动的参考进程。本轮不强制它读取 DesktopChar 的应用配置，因此它的下列进程启动变量暂时保留：

- `DESKTOP_CHAR_TTS_LOCAL_MCP_HOST`
- `DESKTOP_CHAR_TTS_LOCAL_MCP_PORT`
- `DESKTOP_CHAR_TTS_LOCAL_DELAY_MS`
- `DESKTOP_CHAR_TTS_LOCAL_RATE`
- `DESKTOP_CHAR_TTS_LOCAL_CHAR_MS`
- `DESKTOP_CHAR_TTS_LOCAL_MIN_MS`
- `DESKTOP_CHAR_TTS_SAMPLE_RATE_HZ`
- `DESKTOP_CHAR_TTS_CHANNELS`

当 Electron 托管该参考 Provider 时，这些值通过 `ttsMcp.lifecycle.start.env` 传给独立子进程；MCP Adapter 不读取它们。只有用户在命令行独立运行 `local-tts-mcp` 时才需要在 shell 中设置。若后续为独立服务增加配置文件，应使用它自己的 `local-tts-mcp.config.json`，而不是让服务反向依赖 DesktopChar 的整份配置。

## 迁移期环境变量兼容

以下现有变量都将迁入 JSON，但在一个明确的兼容期内仍可作为 fallback 读取：

- `DESKTOP_CHAR_DRAG_HOLD_DELAY_MS`
- `DESKTOP_CHAR_AGENT_PORT`
- `DESKTOP_CHAR_TTS_MODE` 作为 `managed/external` 迁移前的旧别名；新引导变量为 `DESKTOP_CHAR_TTS_LIFECYCLE`
- `DESKTOP_CHAR_TTS_MCP_ENABLED` 及 TTS 连接、超时、格式、voice 变量；工具名和参数名不再允许映射
- `DESKTOP_CHAR_CHARACTER_MCP_ENABLED`、`DESKTOP_CHAR_CHARACTER_MCP_HOST`、`DESKTOP_CHAR_CHARACTER_MCP_PORT`、`DESKTOP_CHAR_CHARACTER_MCP_PATH`

迁移期优先级保持：

```text
有效 JSON 明确值 > 旧环境变量兼容值 > 内置默认值
```

当前优先级和兼容读取均已有测试；来源诊断与一次性弃用提示将在移除兼容项前补齐。兼容期结束后，桌面应用不再把这些变量视为用户配置，但独立服务自己的启动变量不受影响。

`DESKTOP_CHAR_LIP_SYNC_GAIN` 不属于兼容 fallback：它已经由角色目录中的 `lipSyncProfile.gain` 取代，避免全局值覆盖不同资产的校准结果。

API token、Cookie 和密码不写入明文 JSON。未来需要凭证时，JSON 只保存系统凭据存储的引用 ID，敏感值交给操作系统 keychain。

## 实施顺序

1. **已完成**：把现有 MCP loader 泛化为 main 所有的 DesktopConfig，并增加 `version`、schema、应用字段和新旧配置路径引导。
2. **已完成**：迁移拖动、窗口默认值、Agent HTTP 与现有两端 MCP；保留环境变量兼容测试。
3. **已完成**：增加 CharacterProfile schema，把 `MAO_CHARACTER_CONFIG` 迁到模型目录，并覆盖相对路径和非法能力 ID 测试。
4. **下一阶段关键项**：增加 CharacterProfileController、Runtime effect revision 事件和 Gaze/LipSync 平滑热重载；补齐上节六项验收。
5. **待实现**：让设置 UI 通过白名单 IPC 写入应用 JSON，补充原子写入和 last-good revision 测试。
6. **待实现**：把聊天气泡默认值抽成 Runtime Policy，并在有明确用户设置入口后纳入应用 JSON。
