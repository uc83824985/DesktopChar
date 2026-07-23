# Qwen3.5-2B 本地表现规划阅读记录

## 基线

- 官方模型仓库：`https://huggingface.co/Qwen/Qwen3.5-2B`
- 本地参考路径：`../references/Qwen3.5-2B`
- 阅读提交：`15852e8c16360a2fea060d615a32b45270f8a8fc`
- 提交时间：2026-03-02
- 拉取方式：浅克隆并设置 `GIT_LFS_SKIP_SMUDGE=1`

参考仓库与 `DesktopChar` 平级，不进入主仓库构建或提交。当前目录保留模型配置、
chat template、词表和 LFS 指针；未下载完整 safetensors 和 `tokenizer.json`。

## 仓库性质

该仓库是 Hugging Face 模型制品仓库，不是独立推理框架源码。`config.json` 声明
`Qwen3_5ForConditionalGeneration` 和 `model_type=qwen3_5`，具体算子实现由匹配版本的
Transformers、vLLM、SGLang、KTransformers 或 llama.cpp 提供。因此 DesktopChar
不能复制仓库代码作为模型 Adapter，也不能假设任意旧版推理框架都支持该架构。

## 与当前任务相关的实现事实

README 与 `config.json` 给出的关键事实：

- 语言模型参数量为 2B，24 层，hidden size 2048；
- 每四层为三层 Gated DeltaNet/linear attention 加一层 full attention 的混合结构；
- 原生 context length 为 262,144，但本项目不需要为短 segment 分析保留该长度；
- 模型包含 vision encoder；本项目首版只使用文本，服务端应采用 text-only/language-only
  模式避免视觉侧 profiling 和显存占用；
- 2B 后训练模型默认使用 non-thinking 模式；
- 官方 README 给出 SGLang、vLLM、Transformers server 的 OpenAI-compatible API
  启动方式，其中 vLLM 明确提供 `--language-model-only`；
- 官方提醒不同推理框架的效率差异明显，必须在目标框架和硬件上实测。

`chat_template.jinja` 支持 `enable_thinking`，但 DesktopChar 的表现规划请求必须固定为
non-thinking。该任务只生成短 JSON，不保存模型私有多轮历史，也不把 thinking 内容写入
ConversationLedger。

## DesktopChar 使用边界

Qwen3.5-2B 暂定只作为本地 `LocalPerformancePlanner` 背后的首个
`PerformanceInferencePort` Profile：

```text
sealed reply segment
+ Persona performance projection
+ Scene/Avatar projection
+ allowed emotions
+ current Live2D ActionDescriptor[]
                 |
                 v
        Qwen3.5-2B non-thinking
                 |
          constrained JSON
                 |
                 v
           BehaviorPolicy
                 |
                 v
       Avatar PerformanceRuntime
```

它不负责：

- 生成用户可见回复；
- 持有对话上下文或长期记忆；
- 直接调用 Live2D motion；
- 输出 Renderer 的 motion group/index 或文件路径；
- 决定播放顺序、动作冲突和中断；
- 作为角色接入 MCP 中的 Agent。

模型只能从当次 schema 允许的 emotion/action ID 中给出建议。绝对 `atMs` 由播放时间线
决定，模型只返回 segment-start、after-clause、segment-end 等语义锚点。

## 推理与验收假设

目标设备为 RTX 3070，当前目标是单个短 segment 的完整结构化结果 `p95 <= 1s`，
硬超时 2 秒。该数值是项目验收目标，不是官方性能结论。

首轮验证至少比较：

1. Qwen3.5-2B non-thinking、量化模型、短上下文、最多 256 个输出 token；
2. 与 Qwen3-TTS 同时运行时的首 token、完整 JSON、显存峰值和 TTS 首包；
3. schema 约束前后的 action ID 合法率；
4. 中文隐含语气、反问、否定、讽刺和“无动作”样本；
5. 不同 Live2D 动作目录动态切换后是否无需重新训练；
6. 超时、进程退出、模型切换和旧 segment revision 返回时的降级。

如果 2B 与 TTS 同驻时超出显存或尾延迟预算，再比较 Qwen3.5-0.8B 和纯文本
Qwen3-1.7B。MiniLM/专用分类器保留为更低延迟的最终降级，而不是当前首选。

## 2026-07-23 本地环境验证

首个可运行开发环境位于 `performance-model-service`，使用模型无关的
OpenAI-compatible HTTP 边界，当前 Provider 为 Hugging Face Transformers 轻量服务：

- Python 3.11.4；
- PyTorch `2.11.0+cu128`，能够识别本机 RTX 3080；
- Transformers `5.15.0.dev0`，锁定提交
  `c0bd9e62468ec3e20b88b91ddf20375777409331`；
- 官方完整权重 `4,548,221,488` bytes，SHA-256
  `aa33250c4fc64891ddfaba3a314fd9542ea371843c387178b425fbcc5ed680b1`；
- `/health`、`/v1/models` 和 `/v1/chat/completions` 入口已实际启动；
- CPU 兼容模式完成一次中文 non-thinking JSON 生成，输出
  `{"emotion":"happy","action":"nod"}`，耗时约 29 秒。该结果只证明链路可运行，
  不作为性能结论。

当前 Transformers main 有两个需要留在 Provider 封装内的行为：

1. serving extra 漏声明 CLI 所需的 `requests`，本地环境已显式锁定；
2. forced model 使用本地绝对路径时 `/v1/models` 不会列出它，请求中的 `model`
   必须使用 Profile 中的明确值，不能依赖模型发现。

服务提示缺少 `flash-linear-attention` 和 `causal-conv1d` 时会回退到 PyTorch
实现；这不影响功能验证，但不能据此判断 GPU 最终延迟。启动脚本默认关闭 continuous
batching，以减少与 TTS 共存时的显存占用，可在独立并发压测时显式开启。

本次未执行 GPU 生成，因为验证时 RTX 3080 已使用 `9,550 / 10,240 MiB`，仅剩
约 504 MiB；没有结束或干扰现有 Unreal Editor 工作负载。

同日已使用真正的 `OpenAiCompatiblePerformanceAdapter` 完成 CPU 端到端契约诊断：
请求包含动态 emotion/action 目录，Qwen 输出经严格 JSON、ID、anchor、数值范围校验
后归一化为 `LocalPerformanceSuggestion`，本次耗时约 63.9 秒。第一次诊断还发现
prompt 把允许值目录表达成输出示例会诱导模型复制数组；Adapter 已改为明确分离目录
与结果形状。CPU 数据只证明协议链路，不作为实时性能结论。

## 当前未验证项

- 尚未确定最终量化格式和生产推理框架；Transformers 是首个开发验证 Provider；
- 尚未在 GPU 空闲条件下记录首 token、完整 JSON 与显存峰值；
- 尚未在 RTX 3070 上与 Qwen3-TTS 并发压测；
- 尚未建立 Live2D 动作目录标注集；
- 尚未验证 Qwen3.5-2B 在动态 JSON enum 下的稳定性；
- 表现模型 external/managed Supervisor 已实现并共享同一 OpenAI-compatible
  Adapter；managed 会等待 `/v1/models` readiness、监控入口异常退出并回收进程树；
- `OpenAiCompatiblePerformanceAdapter`、规则回退、Runtime Effect Handler 和
  generation/revision 丢弃策略已经实现并通过真实 CPU 服务诊断。
