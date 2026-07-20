# Qwen3-TTS 流式实现阅读记录

## 基线

- 官方仓库：`https://github.com/QwenLM/Qwen3-TTS.git`
- 本地参考路径：`../references/Qwen3-TTS`
- 阅读提交：`022e286b98fbec7e1e916cb940cdf532cd9f488e`
- 提交时间：2026-03-17

参考仓库与 `DesktopChar` 平级，只用于阅读，不进入主仓库构建、提交或运行时依赖。

## 应用场景

Qwen3-TTS 提供 CustomVoice、VoiceDesign 和 Base/VoiceClone 三条主要推理路径，覆盖预置音色与指令控制、自然语言音色设计和参考音频克隆。README 描述其 Dual-Track 架构支持低延迟流式生成，但“模型架构具备流式能力”和“当前公开 Python API 暴露音频流”是两件不同的事。

## 当前公开返回结构

`qwen_tts/inference/qwen3_tts_model.py` 中的 `generate_voice_clone()`、`generate_voice_design()`、`generate_custom_voice()` 返回类型均为：

```python
Tuple[List[np.ndarray], int]  # wavs, sample_rate
```

其中 `non_streaming_mode=False` 的函数说明明确写明：它当前只模拟流式文本输入，并不启用真正的流式输入或流式生成。`generate_voice_clone()` 会先取得完整 `talker_codes_list`，随后一次调用 speech tokenizer decode，最后构造完整 `wavs_out` 并返回。

`qwen_tts/core/models/modeling_qwen3_tts.py` 的生成路径调用 `self.talker.generate()` 后，从全部 hidden states `stack` 出 codes，再按 EOS 截断并返回 code 列表；这里没有 generator、callback、streamer 或逐块 yield 的公开出口。

`qwen_tts/inference/qwen3_tts_tokenizer.py` 最终把解码结果转换为 CPU `float32 numpy.ndarray`，并返回模型输出采样率。12 Hz tokenizer 的配置为：

```text
output_sample_rate = 24000
decode_upsample_rate = 1920
```

## `chunked_decode()` 不等于对外流式返回

`qwen_tts/core/tokenizer_12hz/modeling_qwen3_tts_tokenizer_v2.py` 的 decoder 确实有：

```python
chunked_decode(codes, chunk_size=300, left_context_size=25)
```

它会按 code 块解码，并为后续块带入左上下文；但每块结果先加入本地列表，函数末尾使用 `torch.cat(wavs, dim=-1)` 聚合后一次返回。上层 `decode()` 也接收完整 codes 并返回完整 `audio_values`。因此它当前更像解码内存/上下文处理细节，不能直接作为 HTTP 音频分片接口。

## 对 DesktopChar 的直接结论

1. 不把 `non_streaming_mode=False` 当作服务已支持真正音频流的能力标记。
2. 不让 MCP 工具返回完整 base64 音频；MCP 只返回可立即打开的 HTTP 流描述。
3. 默认传输采用 24 kHz 单声道 `pcm_s16le`；也接受与上游数组更接近的 `pcm_f32le`。
4. 服务端分片必须在生成过程中产生；若先等待 `generate_*()` 返回再分片，只改善传输方式，不改善首包延迟。
5. 若要改造官方内部代码，需要同时解决增量 talker code 产出、带上下文增量 decode、块间连续性、取消和 GPU 资源回收，不能只把 `chunked_decode()` 中的列表改成 `yield`。
6. Adapter 通过 `request_id` 关联控制面与数据面；响应错配会被拒绝，中断时调用独立取消工具。

## 本轮落地映射

| Qwen3-TTS 事实 | DesktopChar 决策 |
| --- | --- |
| 最终输出是 24 kHz float32 ndarray | 支持 `pcm_f32le`，默认转换为带宽更小的 `pcm_s16le` |
| 公开 `generate_*()` 返回完整列表 | 不把 Python 函数完成当成“stream ready” |
| `non_streaming_mode=False` 仅模拟文本流 | 能力检查依赖 MCP 工具 schema 和实际流描述 |
| 内部 decode 分块后仍 `torch.cat` | HTTP chunk 由服务端增量管线产生，不能直接宣称复用该 API |
| 完整 codes 生成后统一 decode | 真流式服务实现留在 TTS provider，不侵入 Avatar Runtime |

详细的 MCP/HTTP 契约见 [TTS Adapter：流式优先契约](../tts-adapter.md)。
