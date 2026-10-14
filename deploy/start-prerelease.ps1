$ErrorActionPreference = 'Stop'
$previewProjectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $previewProjectRoot
try { & node (Join-Path $previewProjectRoot 'scripts/prerelease.mts') start; if ($LASTEXITCODE -ne 0) { throw '预发布启动失败，请查看预发布报告与日志。' } }
finally { Pop-Location }
