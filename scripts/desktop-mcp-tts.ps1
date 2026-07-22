param(
  [string]$McpUrl = "http://127.0.0.1:8766/mcp",
  [string]$Tool = "tts_open_stream",
  [string]$CancelTool = "tts_cancel_synthesis",
  [string]$RequestIdArgument = "request_id",
  [string]$TextArgument = "text",
  [string]$Format = "pcm_s16le",
  [int]$TimeoutMs = 30000,
  [string]$Voice = "",
  [string]$AgentPort = ""
)

$ErrorActionPreference = "Stop"

$env:DESKTOP_CHAR_TTS_MODE = "mcp"
$env:DESKTOP_CHAR_TTS_MCP_URL = $McpUrl
$env:DESKTOP_CHAR_TTS_MCP_TOOL = $Tool
$env:DESKTOP_CHAR_TTS_MCP_CANCEL_TOOL = $CancelTool
$env:DESKTOP_CHAR_TTS_REQUEST_ID_ARGUMENT = $RequestIdArgument
$env:DESKTOP_CHAR_TTS_TEXT_ARGUMENT = $TextArgument
$env:DESKTOP_CHAR_TTS_FORMAT = $Format
$env:DESKTOP_CHAR_TTS_TIMEOUT_MS = [string]$TimeoutMs

if ($Voice.Trim().Length -gt 0) {
  $env:DESKTOP_CHAR_TTS_VOICE = $Voice
}
else {
  Remove-Item Env:\DESKTOP_CHAR_TTS_VOICE -ErrorAction SilentlyContinue
}

if ($AgentPort.Trim().Length -gt 0) {
  $env:DESKTOP_CHAR_AGENT_PORT = $AgentPort
}

Write-Host "[desktop-char] 语音合成 MCP mode enabled"
Write-Host "[desktop-char] MCP URL: $env:DESKTOP_CHAR_TTS_MCP_URL"
Write-Host "[desktop-char] Tool: $env:DESKTOP_CHAR_TTS_MCP_TOOL"
Write-Host "[desktop-char] Cancel tool: $env:DESKTOP_CHAR_TTS_MCP_CANCEL_TOOL"
Write-Host "[desktop-char] Format: $env:DESKTOP_CHAR_TTS_FORMAT"
Write-Host "[desktop-char] Timeout: $env:DESKTOP_CHAR_TTS_TIMEOUT_MS ms"

npm run desktop
