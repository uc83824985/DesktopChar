$ErrorActionPreference = 'Stop'

if ($args.Count -lt 1) {
    throw 'WorkAssistant launcher script path is required'
}

$launcherScript = [System.IO.Path]::GetFullPath([string]$args[0])
$codexArgs = if ($args.Count -gt 1) { @($args[1..($args.Count - 1)]) } else { @() }
if (-not (Test-Path -LiteralPath $launcherScript -PathType Leaf)) {
    throw "WorkAssistant launcher script was not found: $launcherScript"
}

$launcherDirectory = Split-Path -Parent $launcherScript
$launcherConfigPath = Join-Path $launcherDirectory 'config.json'
$launcherLibraryPath = Join-Path $launcherDirectory '..\_inner\lib_cli_launcher.ps1'
if (-not (Test-Path -LiteralPath $launcherConfigPath -PathType Leaf)) {
    throw "WorkAssistant launcher config was not found: $launcherConfigPath"
}
if (-not (Test-Path -LiteralPath $launcherLibraryPath -PathType Leaf)) {
    throw "WorkAssistant launcher library was not found: $launcherLibraryPath"
}

. $launcherLibraryPath

$launcherConfig = Get-Content -LiteralPath $launcherConfigPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
Merge-DefaultConfig -Config $launcherConfig -ScriptDir $launcherDirectory | Out-Null

$command = [string]$launcherConfig.command
if (-not $command) {
    throw "WorkAssistant launcher command is empty: $launcherConfigPath"
}

$baseArgs = @()
if ($launcherConfig.args) {
    $baseArgs += Split-CommandLineArgs -CommandLine ([string]$launcherConfig.args)
}

& $command @baseArgs @codexArgs
if ($null -ne $LASTEXITCODE) {
    exit $LASTEXITCODE
}
