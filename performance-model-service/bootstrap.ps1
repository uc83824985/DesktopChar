[CmdletBinding()]
param(
  [string]$ModelPath,
  [ValidateSet("git-lfs", "modelscope")]
  [string]$DownloadSource = "git-lfs",
  [switch]$SkipModelDownload
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ModelPath)) {
  $ModelPath = Join-Path $PSScriptRoot "..\..\references\Qwen3.5-2B"
}

$uv = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uv) {
  throw "uv was not found. Install uv and retry."
}

$resolvedModelPath = [System.IO.Path]::GetFullPath($ModelPath)
$modelConfig = Join-Path $resolvedModelPath "config.json"
if (-not (Test-Path -LiteralPath $modelConfig -PathType Leaf)) {
  throw "Qwen3.5 model repository was not found at: $resolvedModelPath"
}

if (-not $SkipModelDownload) {
  if ($DownloadSource -eq "git-lfs") {
    $gitLfs = & git lfs version 2>$null
    if ($LASTEXITCODE -ne 0) {
      throw "Git LFS was not found. Install Git LFS and retry."
    }

    Write-Host "Downloading Qwen3.5 model artifacts with Git LFS..."
    & git -C $resolvedModelPath lfs pull --include="model.safetensors-00001-of-00001.safetensors,tokenizer.json"
    if ($LASTEXITCODE -ne 0) {
      throw "Git LFS failed to download Qwen3.5 model artifacts."
    }
  } else {
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if (-not $curl) {
      throw "curl.exe was not found."
    }

    $artifacts = @(
      @{
        Name = "model.safetensors-00001-of-00001.safetensors"
        Sha256 = "aa33250c4fc64891ddfaba3a314fd9542ea371843c387178b425fbcc5ed680b1"
      },
      @{
        Name = "tokenizer.json"
        Sha256 = "5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42"
      }
    )

    foreach ($artifact in $artifacts) {
      $target = [System.IO.Path]::GetFullPath((Join-Path $resolvedModelPath $artifact.Name))
      $temporary = "$target.download"
      if (-not $target.StartsWith($resolvedModelPath) -or -not $temporary.StartsWith($resolvedModelPath)) {
        throw "Resolved artifact path escaped the model repository."
      }

      $validExistingArtifact = (Test-Path -LiteralPath $target -PathType Leaf) -and
        ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -eq $artifact.Sha256)
      if ($validExistingArtifact) {
        Write-Host "$($artifact.Name) is already complete."
        continue
      }

      $url = "https://www.modelscope.cn/models/Qwen/Qwen3.5-2B/resolve/master/$($artifact.Name)"
      Write-Host "Downloading $($artifact.Name) from the official Qwen ModelScope mirror..."
      & $curl.Source -L --fail --retry 5 --retry-delay 2 -C - -o $temporary $url
      if ($LASTEXITCODE -ne 0) {
        throw "Failed to download $($artifact.Name) from ModelScope."
      }

      $actualHash = (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash
      if ($actualHash -ne $artifact.Sha256) {
        throw "$($artifact.Name) failed SHA-256 verification."
      }

      Move-Item -LiteralPath $temporary -Destination $target -Force
    }
  }
}

Write-Host "Creating and synchronizing the isolated Python environment..."
& $uv.Source sync --project $PSScriptRoot
if ($LASTEXITCODE -ne 0) {
  throw "uv sync failed."
}

$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
& $python -c "import torch, transformers; print(f'torch={torch.__version__} cuda_build={torch.version.cuda} cuda_available={torch.cuda.is_available()}'); print(f'transformers={transformers.__version__}')"
if ($LASTEXITCODE -ne 0) {
  throw "The Qwen3.5 environment verification failed."
}

Write-Host "Qwen3.5 environment is ready."
