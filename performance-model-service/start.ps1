[CmdletBinding()]
param(
  [string]$ModelPath,
  [ValidateRange(1, 65535)]
  [int]$Port = 18090,
  [switch]$Cpu,
  [switch]$ContinuousBatching
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ModelPath)) {
  $ModelPath = Join-Path $PSScriptRoot "..\..\references\Qwen3.5-2B"
}

$resolvedModelPath = [System.IO.Path]::GetFullPath($ModelPath)
$weights = Join-Path $resolvedModelPath "model.safetensors-00001-of-00001.safetensors"
$server = Join-Path $PSScriptRoot ".venv\Scripts\transformers.exe"

if (-not (Test-Path -LiteralPath $server -PathType Leaf)) {
  throw "The environment is missing. Run .\bootstrap.ps1 first."
}
if (-not (Test-Path -LiteralPath $weights -PathType Leaf)) {
  throw "Model weights are missing. Run .\bootstrap.ps1 first."
}
if ((Get-Item -LiteralPath $weights).Length -lt 1GB) {
  throw "Model weights are still a Git LFS pointer. Run .\bootstrap.ps1 without -SkipModelDownload."
}

$env:PYTHONUTF8 = "1"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
$env:HF_HUB_CACHE = Join-Path $PSScriptRoot ".cache\huggingface\hub"
New-Item -ItemType Directory -Force -Path $env:HF_HUB_CACHE | Out-Null
if ($Cpu) {
  $env:CUDA_VISIBLE_DEVICES = "-1"
}

Write-Host "Starting Qwen3.5 service on http://127.0.0.1:$Port/v1"
Write-Host "Model: $resolvedModelPath"
if ($Cpu) {
  Write-Host "Device policy: CPU"
} else {
  Write-Host "Device policy: CUDA 0"
}

$serverArguments = @(
  "serve",
  $resolvedModelPath,
  "--host", "127.0.0.1",
  "--port", "$Port",
  "--enable-cors",
  "--reasoning", "off",
  "--device", $(if ($Cpu) { "cpu" } else { "cuda:0" })
)
if ($Cpu -or -not $ContinuousBatching) {
  $serverArguments += "--no-continuous-batching"
} else {
  $serverArguments += @("--continuous-batching", "--cb-max-memory-percent", "0.65")
}

& $server @serverArguments
exit $LASTEXITCODE
