# 角色动态表情目录与选择设计

## 状态

表现规划契约 v2、角色目录、确定性 Resolver、Adapter/Transport 分层和 Runtime
`expressionKey` 状态已于 2026-07-24 落地。带 `expressionCatalog` 的角色走 v2；
没有目录的旧角色继续使用 `desktop-char.performance-planning.v1`、固定 `Emotion`
和 `emotionBindings`，兼容路径暂不删除。

## 问题

固定 `neutral / happy / sad / angry / surprised / thinking` 槽位只能证明
Runtime 到 Live2D expression 的链路可用，不能成为长期资产模型：

- 每个角色拥有不同数量、不同语义和不同视觉约定的表情资源；
- 害羞、星星眼、嫌弃、无语等角色特有表现不能稳定压入少量全局枚举；
- 多个自然语言语义可能对应同一个视觉资源，同一语义也可能有多个资源变体；
- 新增角色资源不应要求修改 Contracts 联合类型、Runtime 分支或重新训练固定分类头；
- 小模型不能绕过 Runtime 直接调用 expression 文件或写 Live2D 参数。

固定 `Emotion` 后续降级为可选的粗粒度情感事实，不再承担“全局表情槽”的职责。

## 设计结论

采用“角色动态 ExpressionCatalog + 可替换推理 Adapter + ExpressionResolver
最终选择”的混合方式。Qwen3.5 是首个可选 Provider，不是领域依赖：

```text
sealed segment + Persona + Scene + Avatar state
                         |
                         +--> TTS
                         |
                         v
       Optional Performance Inference
              affect + ranked candidates
                         |
                         v
               ExpressionResolver
       catalog / history / cooldown / transition
                         |
                         v
                 AvatarRuntime
       active key / revision / generation / timing
                         |
                         v
            validated renderer Effect
                         |
                         v
          character binding -> Live2D resource
```

模型结果始终是建议。Resolver 和 AvatarRuntime 共同完成白名单、时序、冷却、重复抑制
和过期结果丢弃；Renderer 只执行已经确定的 binding。

## 角色级目录

目录中的 `expressionKey` 是角色作用域内稳定的逻辑 ID，不是 `exp_08`、文件路径或
Cubism SDK 对象。给小模型的推理投影不包含 `resource`：

```ts
interface ExpressionDescriptor {
  expressionKey: string;
  label: string;
  semanticTags: string[];
  prototypeTexts: string[];
  affectPrototype?: Partial<AffectVector>;
  baseWeight: number;
  cooldownMs: number;
  holdMs: { minMs: number; maxMs: number };
  compatibleAvatarStates: AvatarState[];
}

interface ExpressionBinding {
  expression: string | null;
}
```

角色 sidecar 同时保存 descriptor 和 binding，加载时必须验证：

- `expressionKey` 唯一且不依赖文件名；
- 非空 `binding.expression` 确实存在于当前 `model3.json -> Expressions`；
- enabled 的每个资源至少具有 label、语义标签或原型句，不能成为永远不可达的孤儿；
- Neutral/reset binding 唯一；
- cooldown、hold 和权重有明确范围；
- catalog revision 改变后，旧 revision 的推理结果不能提交。

一个视觉资源可声明多个语义标签。例如 Mao 的 `disdain` 可以包含
`displeased / dismissive / speechless`，不需要复制三份全局 Emotion binding。
走神主要是 attention/gaze 行为，不应因为“半睁眼”就错误复用带怒嘴的资源。

## AffectVector

连续维度用于跨角色迁移和模型失败时的确定性兜底，首版候选维度为：

```ts
interface AffectVector {
  valence: number;    // -1 消极，+1 积极
  arousal: number;    //  0 平静，1 高唤醒
  approval: number;   // -1 反感，+1 认同/喜爱
  engagement: number; //  0 脱离注意，1 高度投入
  certainty: number;  //  0 犹疑，1 确定
}
```

维度不是新的 Live2D 参数，也不能直接逐项映射到模型参数。只使用维度会把害羞、
无语、担忧和嫌弃压到相近位置，所以 v2 同时保留动态目录候选排序。

## 表现模型 v2 输出

建议以新 contract version 与 v1 并存，不静默修改 v1：

```ts
interface LocalPerformanceSuggestionV2 {
  contractVersion: 'desktop-char.performance-planning.v2';
  requestId: string;
  segmentId: string;
  segmentRevision: number;
  catalogRevision: number;
  source: 'model' | 'rules';
  provider: string;
  affect?: AffectVector;
  expressionCandidates: Array<{
    expressionKey: string;
    confidence: number;
    intensity: number;
  }>;
  actions: PerformanceActionSuggestion[];
}
```

约束：

- `expressionCandidates` 最多三个，ID 必须来自当次目录且不能重复；
- 模型可以返回空候选，不能为了“有表情”强行选择；
- affect 和 confidence/intensity 必须为有限且有界数值；
- 结果继续携带 segment revision，并新增 catalog revision；
- 模型不输出绝对播放时间、Live2D 参数、资源路径或随机种子。

## Adapter 与 Transport

v2 将领域映射和模型通信拆成两个独立端口：

```text
PerformancePlanningRequestV2
        |
        v
ExpressionCatalogPlanningAdapter
  prepare semantic prompt / parse + whitelist
        |
        v
PerformanceModelTransport
  OpenAI-compatible / future in-process / fixture
```

- Adapter 只接收 `ExpressionDescriptor[]`，负责构造模型无关的文本生成请求，并严格
  解析 Affect、候选 key、动作 ID 和数值范围；
- Transport 只负责文本补全、超时、取消和 Provider 名称，不理解角色目录或 Live2D；
- `bindings` 不在 `PerformancePlanningRequestV2` 中，测试会拒绝资源 ID 泄漏；
- 模型关闭或失败时，`RuleBasedExpressionCatalogInference` 直接实现同一 v2 Port，
  无需经过 Transport；
- 当前 OpenAI-compatible Transport 仍是 prompt-only JSON；未来切换 vLLM、SGLang、
  本地分类器或进程内模型，不改变 Runtime、Resolver 和 CharacterProfile。

## ExpressionResolver

Resolver 使用模型候选和目录元数据计算最终分数：

```text
score =
  model confidence
  + affect prototype similarity
  + Persona / Scene compatibility
  + transition compatibility
  + base weight
  - cooldown penalty
  - recent repetition penalty
```

高置信、明显领先的候选可以直接选择；其余情况在 top-k 中进行带权抽样。随机性由
Runtime 持有的可注入 seed 驱动，而不是依赖模型温度，这样生产表现有变化、测试结果
仍可复现。

Runtime 至少持有：

- 当前 `expressionKey`、intensity 和开始时间；
- catalog revision；
- 最近使用历史与 cooldown；
- 当前 segment/generation；
- 进入、退出和 Neutral 过渡状态。

当前 Renderer 对 expression 仍是整份资源应用，`intensity` 尚不能安全缩放资源权重。
首阶段只把 intensity 用于选择阈值；Resolver 会生成目标 `holdMs`，Runtime 将其记录为
`holdUntilMs`，但当前不会另起与播放时钟脱离的墙钟定时器。表情保持到下一条合法
expression cue、计划结束或中断为止；后续需要在音频播放时钟上实现独立的保持到期
cue。安全插值只允许：

1. Neutral 与单个已制作 expression 之间的受控权重插值；
2. Profile 明确声明同一 blend group 和参数所有权后，才组合多个资源。

禁止让小模型直接生成任意 Live2D 参数组合；这会产生眼、眉、嘴冲突，并绕过眨眼、
口型和 Gaze 的 Updater 顺序。

## Mao 当前目录审阅

2026-07-24 已以锁定基准姿态的面部截图和 `exp3.json` 参数交叉确认：

| expressionKey 建议 | 资源 | 视觉事实 | 语义标签建议 |
| --- | --- | --- | --- |
| `neutral` | `exp_01` / reset | 中立、正常睁眼 | neutral, reset |
| `closed-eye-smile` | `exp_02` | 闭眼笑 | happy, warm |
| `eyes-closed-calm` | `exp_03` | 闭眼但没有笑眼 | thinking, calm, pause |
| `starry-eyed` | `exp_04` | 放大眼睛与星星效果 | excited, admiring, expectant |
| `sad-worried` | `exp_05` | 低眉、嘴角向下 | sad, worried |
| `blushing-uneasy` | `exp_06` | 脸红并带低眉 | shy, embarrassed, uneasy |
| `startled` | `exp_07` | 放大眼睛、瞳孔和眉形变化 | surprised, startled, alarmed |
| `disdain` | `exp_08` | 半睁眼，同时带怒嘴与怒线 | displeased, dismissive, speechless |

这张表是当前角色目录的人工元数据起点，不是全局 Emotion 枚举。

## Qwen3.5-2B 可行路径

Qwen3.5-2B 适合先验证动态目录，因为任务仍是短文本、non-thinking、有限候选的结构化
选择。推荐一次推理同时返回 affect、最多三个 expression candidate 和 action candidate，
避免先分类再二次调用模型。

首轮对照实验固定使用 Mao 的八项完整目录：

1. **Direct**：只让模型返回目录候选；
2. **Affect**：只返回连续维度，由 Resolver 最近邻选择；
3. **Hybrid**：同时返回 affect 与候选，由 Resolver 融合；
4. **v1 baseline**：保留当前固定 emotion 输出作为准确率和延迟对照。

短目录直接完整放入 prompt。目录增长后先通过 prototype text/embedding 召回，再让
Qwen 对 top-k 重排；不能无限增加单次 prompt。

模型温度保持低值以提高 JSON 和候选稳定性，表演随机性放在 Resolver。必须统计：

- 严格 JSON 合法率和非法 ID 率；
- 人工标注的 top-1 / top-3 命中率；
- 八项资源可达性及 neutral/空候选比例；
- 连续对话中的重复率和冷却命中；
- 中文反问、讽刺、否定、嫌弃、无语、害羞和走神样本；
- p50/p95 完整 JSON 延迟、显存峰值及对 Qwen3-TTS 首包的影响。

## 渐进迁移与实施状态

### 阶段 A：数据与确定性 Resolver

- **已完成**：CharacterProfile 新增可选 `expressionCatalog`，保留 v1
  `emotionBindings`；
- **已完成**：Mao 八个资源均有 descriptor、binding、schema 和真实
  `model3.json` 可达性测试；
- **已完成**：实现不依赖模型的 ExpressionResolver、固定 seed、冷却与重复测试。

### 阶段 B：表现规划 v2

- **已完成**：新增 contract v2、领域 Adapter、严格 validator 和通用
  `PerformanceModelTransport`，未修改 v1 parser；
- **已完成**：动态目录请求返回 affect + ranked candidates；
- **已完成**：Provider 未启用或推理失败时使用确定性目录规则；
- **已完成**：通过 segment/catalog revision 丢弃迟到结果。

### 阶段 C：Runtime 正式切换

- **已完成**：Timeline 和 Snapshot 以 `expressionKey` 为正式状态；
- **已完成**：粗粒度 Emotion 只作为可选上下文事实和兼容输入；
- **已完成**：`renderer.set-expression` 只接收 Runtime 已解析、已校验的 binding；
- **已完成**：显式未知 key、重复/未知候选和旧 catalog revision 均被拒绝。

### 阶段 D：安全插值和大目录

- **暂不实现插值**：现有 Cubism expression 是整份参数资源，Profile 尚未声明参数
  所有权；直接按 intensity 混合可能再次破坏眨眼、Gaze 和口型 Updater 顺序；
- Mao 只有八项，完整目录 prompt 更稳定，不引入无收益的检索层；
- 目录显著扩大后再增加 shortlist、blend group 和参数所有权；
- 真实 Qwen3-TTS 并发压测完成后，再决定保留 2B、切换 0.8B 或增加专用分类器。

## 必须覆盖的测试

- 两个角色使用不同目录时，相同文本可得到不同合法资源；
- 每个 enabled 资源至少能被一个人工 fixture 或原型向量选中；
- 未知、重复和旧 catalog revision 的候选被拒绝；
- 固定 seed 下选择稳定，改变 seed 只在合法 top-k 内变化；
- cooldown、重复惩罚和 Neutral 回退不会让 Runtime 卡住；
- 推理迟到时不覆盖已提交 segment；
- expression 与动作、Gaze、眨眼和口型仍遵守 Runtime/Updater 所有权。
