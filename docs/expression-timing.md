# 段内表情时序调研与阶段性实现

## 结论

当前阶段不把精确字词时间戳作为段内表情的前置依赖。Runtime 先使用“自然分句并发分析 +
文本位置锚点 + 播放时绑定”的方式改善长句中的表情变化，同时保留精确 `atMs` 的优先通道。

原因不是强制对齐速度不足，而是当前本地语音链路没有可直接消费的在线时间戳：

- Qwen3-TTS 当前公开高级推理接口返回最终波形，不返回字、词或音素时间戳；已有
  `non_streaming_mode=False` 不能视为带时间戳的在线音频接口，详见
  [Qwen3-TTS 阅读记录](references/qwen3-tts.md)。
- [Qwen3-ForcedAligner-0.6B](https://github.com/QwenLM/Qwen3-ASR)
  接收已知文本和与之匹配的音频，返回中文字符级或其他语言词级时间戳。它是 Qwen3-ASR
  系列中的独立非自回归模型，不是 Qwen3-TTS 内部扩展。
- [Qwen3-ASR 技术报告](https://arxiv.org/pdf/2601.21337)公开的约 60 秒音频测试中，
  ForcedAligner 单并发 RTF 为 `0.00889`，证明完成音频的后处理吞吐远快于实时；测试使用
  `bfloat16 + FlashAttention`，但论文没有披露“单个典型计算资源”的具体 GPU，也没有给出
  RTX 3070 上 2–8 秒短音频的 P50/P95 延迟。
- 同一报告明确将 ForcedAligner 标为 PyTorch 离线批处理。官方仓库也注明流式 ASR
  当前不能返回时间戳。因此它适合在一个音频单元完成后快速对齐，不能在 TTS 每产生一小块
  PCM 时稳定报告“现在读到哪个字”。

当 TTS 生成速度仅略快于播放时，在同一 GPU 串行执行的稳态条件为：

```text
TTS_RTF + Aligner_RTF < 1
即 1 / TTS速度倍数 + Aligner_RTF < 1
```

按官方单并发数据，ForcedAligner 的纯计算预算很小；但短音频固定开销、模型常驻显存、
CUDA 调度及与 Qwen3-TTS 的同卡竞争尚未在目标 RTX 3070 上确认。现阶段不把它放进首句或
正在播放语句的硬关键路径。

## 当前无时间戳实现

当前 v2 表现链路保持一个自然语音段只调用一次 TTS，不为了每个表情切换把语音切成碎片。
表情分析在文本侧拆分：

```text
PerformanceSegment.speechText
        |
        v
自然分句（强标点；足够长时允许逗号/冒号）
        |
        +--> 本地规则 provisional cue（1–3ms，立即进入时间线）
        |
        +--> clause 0 模型推理 ─┐
        +--> clause 1 模型推理 ─┼─ 客户端并发；Provider 可顺序执行
        +--> clause N 模型推理 ─┘
                                  |
                                  v
       模型在 cue 播放前可修正 expressionKey + 原文 expressionTrigger
                         |
                         v
          本地校验并计算句内 PerformanceTextAnchor
                                  |
                                  v
             PerformanceTimeline 播放时绑定
```

实现约束：

- 单个语音段最多拆成 6 个推理分句，避免长回复瞬间制造无界并发；
- 分句携带 Unicode code-point 范围、分句序号和全文字符数；模型除判断当前分句的表现外，
  还必须逐字复制最短的 `expressionTrigger` 原文短语，不生成字符偏移或毫秒值；
- Adapter 验证 `expressionTrigger` 是分句的连续原文子串，再按 Unicode code point
  换算为全文锚点。因此“不过这个结果竟然有点出乎意料”会锚定到“竟然”，而不是
  “不过”所在的分句开头；
- 第一分句可以同时选择句首动作；后续分句当前只产生表情，避免多个并发结果重复触发动作；
- `fallbackToRules=true` 且模型在线时，确定性规则会先生成 provisional cue；它不结束模型
  请求，模型结果若在该 cue 播放前到达，会按相同分句 identity 覆盖它；已经触发的 cue
  不会因迟到结果重放；
- 音频源提供 `durationMs` 时，Runtime 按文本进度比例映射到播放位置；
- 流式音频没有总时长时，按当前 TTS Profile 的
  `timing.fallbackCharactersPerSecond` 估算分句开始点；`local` 当前为 `4.31`
  字符/秒（约 `232ms/字符`），`qwen` 当前为 `5.56` 字符/秒（约
  `180ms/字符`）；
- 相邻分句选中同一 `expressionKey` 时保持当前表情，不重复提交 Cubism expression，
  避免重新触发淡入造成闪动；
- 推理迟到后，Timeline 只补充尚未触发的未来 cue；已经越过的 cue 会立即应用，不等待下一次
  播放 tick；
- 显式 `ExpressionCue.atMs` 始终优先于文本锚点，因此精确时间戳接入不会改变 Renderer
  和表情资源契约。

不让小模型直接输出连续 affect 曲线有两个原因：2B 模型对 Unicode 偏移和毫秒数的计算
不够稳定，而每个 token 一组 valence/arousal 会增加响应体、推理延迟和抖动。短语抽取把
模型限制在其更擅长的语义定位任务，实际过渡曲线继续由 Live2D expression 的 fade 和
“相同表情保持”策略负责。

这是“语义触发位置正确、音频时间近似”的过渡方案。它能避免整段长回复只维持一个表情，
也不会让 Qwen3-TTS 因过细分句而损失连贯语气，但在没有音频时间戳时仍不能保证切换精确
落在实际发音边界。

## 后续精确时间戳接入点

后续可以增加独立的 Timeline Binder，将同一个 `PerformanceTextAnchor` 转换为精确
`ExpressionCue.atMs`：

```text
PerformanceTextAnchor
        |
        +--> TTS 原生 text/phoneme timing
        |
        +--> 完整小句音频 + Qwen3-ForcedAligner
        |
        +--> 其他 Provider 的 word boundary
                    |
                    v
             exact ExpressionCue.atMs
```

优先顺序建议为：

1. TTS 原生且与波形同源的字词/音素时间戳；
2. 已完整生成的短自然语句交给 ForcedAligner；
3. 已知音频总时长下的文本比例映射；
4. 未知总时长下的字符语速估算。

第 4 级降级不是 Runtime 常量，而是写在
`tts-mcp-profiles/<name>.json` 的 Provider/Profile 参数。该值应按所选音色、
`synthesis.rate` 和实测有效语速校准。TTS Adapter 会把当前值固化到本次
`AudioSource`，因此热切换 Profile 不会改变已经生成或正在播放的语音时间轴。

Runtime 为每个表情 cue 记录 `timingBasis`：`exact`、`duration-ratio`、
`configured-rate` 或 `immediate-fallback`，并同时记录计划位置、实际播放位置、
误差和文本锚点，便于后续把近似时点与 ForcedAligner 结果做对照。

前台可点击“段内表情测试”，或用下面的开发验收入口随 Electron 启动自动运行一次
“开心 → 惊讶 → 思考”的同段语音。验收必须使用完整桌面启动链路：

```powershell
$env:DESKTOP_CHAR_EXPRESSION_FLOW_AUDIT = "1"
npm run desktop
```

页面诊断状态记录在 `data-expression-flow-*`（包括最后一个触发短语），三种不同表情 cue 均触发后
`data-expression-flow-test` 变为 `passed`；控制台对应输出
`expression.clause-requested`、`expression.timeline-started`、
`expression.cue-fired`/`expression.cue-held` 和 `expression.applied`。

### 2026-07-27 前台验收记录

使用 `npm run desktop`、Local TTS 和 12.071 秒同段语音实际播放：

| 表情 | 触发原文 | 全文 code-point 锚点 | 计划位置 | 实际位置 | 播放误差 |
| --- | --- | ---: | ---: | ---: | ---: |
| `closed-eye-smile` | `太好` | `9..11` | 2263ms | 3631ms | +1368ms |
| `startled` | `竟然` | `19..21` | 4778ms | 4781ms | +3ms |
| `eyes-closed-calm` | `让我想想` | `36..40` | 9053ms | 9079ms | +26ms |

三项均已实际进入 `expression.applied`，证明切换点不再固定为三个分句的
`0 / 13 / 28` 起点。该轮启用的 Qwen3.5-2B 三个并发请求都超过当前 `5000ms`
deadline，实际建议来源为 `deterministic-catalog-rules`。因此本轮确认了“句内语义锚点 +
播放绑定”有效，也同时暴露出首个 cue 的延迟问题：第一项在计划时点之后才收到推理结果，
只能立即补用，晚了 1368ms；后两项因仍有前视时间而准确落点。

这说明增加模型超时不会改善首句体验。后续若模型实测仍不能在首个触发点前返回，应采用
“首个短语快速规则/轻量分类器先给 provisional cue，较慢模型只修正尚未播放的 cue”，
或进一步降低模型首 token 延迟；不能让播放等待表情推理。

### 2026-07-27 并发超时复核与优化后验收

关闭 UE 编辑器后，旧协议的三路请求仍在约 `5007ms` 同时进入客户端超时，GPU 采样曾达到
`98%`。这排除了“只要释放 UE GPU 负载就会恢复”的解释。进一步确认了四个瓶颈：

- 旧模型响应要求完整 affect、候选数组和动作数组，单请求诊断约 25 秒，并在
  `maxOutputTokens=256` 时产生截断 JSON；
- 当前 Transformers 服务收到三路 HTTP 请求，但 Qwen3.5-2B 不能使用该服务的
  continuous batching。即使显式开启，服务仍报告
  `Qwen3_5ForConditionalGeneration does not support continuous batching` 并退回
  sequential generation；
- HTTP 客户端超时/取消后，服务端生成没有立即停止，GPU 仍继续工作；因此仅缩短 timeout
  不能释放已经排队的计算；
- 服务还提示缺少 `flash-linear-attention` 与 `causal-conv1d`，当前使用 PyTorch
  fallback kernel。这是可继续优化项，但不是本轮引入额外依赖的前提。

本轮把模型可见输出压缩为三个扁平字段：

```json
{"expressionKey":"startled","trigger":"竟然","intensity":1}
```

动作改由本地规则选择，affect、候选数组、置信度和锚点不再要求模型生成；Adapter 仍在
本地恢复完整 `LocalPerformanceSuggestionV2`。明显情绪词还会经过本地 semantic guard，
避免模型错误返回默认表情或虚构触发短语。单请求 warm 诊断由约 25 秒降至约 3.0 秒。

最终前台配置使用 `timeoutMs=10000`、`maxOutputTokens=64`。更长 deadline 不阻塞播放，
因为 provisional cue 已先进入时间线；它只是允许顺序执行的后续模型响应被接收。Local
TTS 的 12.071 秒同段语音结果如下：

| 分句 | provisional | 模型完成 | 最终表情 | 计划位置 | 实际位置 | 播放误差 |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| `太好` | 3ms | 2710ms | `starry-eyed` | 2263ms | 2282ms | +19ms |
| `竟然` | 2ms | 4828ms | `startled` | 4778ms | 4781ms | +3ms |
| `让我想想` | 1ms | 7630ms | `eyes-closed-calm` | 9053ms | 9082ms | +29ms |

三路最终都来自模型链路（第三路由 semantic guard 修正），没有超时或退回最终 fallback。
这验证了当前更稳妥的实时策略：播放和 TTS 不等待表现模型，本地结果保证 deadline，模型
利用后续分句的前视时间提升选择质量。

ForcedAligner 接入前必须在目标机器测量：

- 2、4、8、12 秒中文音频的 warm P50/P95；
- 与 Qwen3-TTS 同时常驻时的峰值显存；
- TTS 单独运行与并发/串行对齐时的 RTF 变化；
- 模型首次加载、GPU 上下文切换和短音频固定开销；
- 以真实播放队列统计 underrun，而不是只看 aligner 单模型吞吐。

如果无法常驻或会明显拖慢 TTS，对齐器只能用于已有足够前视缓冲的后续语句，不能为了段内
表情暂停当前语音。缓冲不足时继续使用文本锚点，或退化为整句表情。
