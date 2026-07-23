# Local performance model service

This directory contains a reproducible Windows development environment for the first
DesktopChar `PerformanceInferencePort` profile. Qwen3.5-2B is served through the
Hugging Face Transformers OpenAI-compatible HTTP server; the DesktopChar engine does
not import Qwen or Transformers classes.

## Layout

- Python dependencies and the virtual environment live under this directory.
- Model artifacts remain in the sibling reference repository at
  `../../references/Qwen3.5-2B`.
- `.venv` and model weights are local development artifacts and are not committed to
  the DesktopChar repository.

## Bootstrap

From this directory in PowerShell:

```powershell
.\bootstrap.ps1
```

The script downloads the two Git LFS artifacts, creates `.venv` with `uv`, and verifies
the installed CUDA-enabled PyTorch and Transformers builds.

For machines where Hugging Face Git LFS is slow, use the official Qwen ModelScope
mirror. The script verifies both artifacts against the SHA-256 values recorded in the
Hugging Face Git LFS pointers before replacing them:

```powershell
.\bootstrap.ps1 -DownloadSource modelscope
```

## Start

```powershell
.\start.ps1
```

The OpenAI-compatible endpoint is available at `http://127.0.0.1:18090/v1`.
The development launcher enables CORS because the Electron renderer calls this
loopback endpoint through the model-independent HTTP adapter.
Use `.\start.ps1 -Cpu` only for compatibility diagnostics; normal latency acceptance
must use the GPU.

Continuous batching is disabled by default to reduce VRAM use while Qwen3.5 shares a
consumer GPU with TTS. Use `.\start.ps1 -ContinuousBatching` only when explicitly
benchmarking concurrent performance-model requests.

The full-precision 2B model needs several GiB of free VRAM. Close or reduce other GPU
workloads before starting the service if model loading reports CUDA out of memory.

## Smoke test

In a second PowerShell:

```powershell
.\smoke-test.ps1
```

The test discovers the runtime model id, sends a UTF-8 non-thinking chat completion,
and prints the generated content and elapsed time.

The engine contract diagnostic uses the same adapter and strict response validation
as the desktop renderer:

```powershell
npm run diagnose:performance
```
