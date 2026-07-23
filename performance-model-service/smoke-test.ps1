[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 18090,
  [string]$ModelPath,
  [string]$Prompt = "只输出一个 JSON 对象：{`"emotion`":`"happy`",`"action`":`"nod`"}"
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ModelPath)) {
  $ModelPath = Join-Path $PSScriptRoot "..\..\references\Qwen3.5-2B"
}
$resolvedModelPath = [System.IO.Path]::GetFullPath($ModelPath)
$baseUrl = "http://127.0.0.1:$Port/v1"

$models = Invoke-RestMethod -Method Get -Uri "$baseUrl/models" -TimeoutSec 10
$modelId = if ($models.data.Count -gt 0) { $models.data[0].id } else { $resolvedModelPath }

$request = @{
  model = $modelId
  messages = @(
    @{
      role = "system"
      content = "You are a low-latency Live2D performance planner. Follow the requested output format exactly."
    },
    @{
      role = "user"
      content = $Prompt
    }
  )
  max_tokens = 64
  temperature = 0.1
  stream = $false
}

$json = $request | ConvertTo-Json -Depth 8 -Compress
$body = [System.Text.Encoding]::UTF8.GetBytes($json)
$startedAt = Get-Date
$response = Invoke-RestMethod `
  -Method Post `
  -Uri "$baseUrl/chat/completions" `
  -ContentType "application/json; charset=utf-8" `
  -Body $body `
  -TimeoutSec 120
$elapsed = (Get-Date) - $startedAt
$content = $response.choices[0].message.content

if (-not $content) {
  throw "The service returned an empty chat completion."
}

[pscustomobject]@{
  Model = $modelId
  ElapsedMs = [math]::Round($elapsed.TotalMilliseconds)
  Content = $content
} | Format-List
