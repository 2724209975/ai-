param([Parameter(Mandatory=$true)][int]$WeChatProcessId, [switch]$CheckOnly)
# OWNER EXECUTION ONLY. The AI must never execute this script against WeChat.
$ErrorActionPreference='Stop'
$run=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'owner-run.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$dll=Join-Path $PSScriptRoot 'wxhelper.dll'
$expected='CEE4375B6F795CE014F62C80A9A08BE178E4F08EC8E8EA2974820382FCE7895B'
if ((Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash -ne $expected) { throw 'P4_HELPER_CHANGED' }
if ((Get-FileHash -LiteralPath $run.client -Algorithm SHA256).Hash -ne '2058A926258BAEAECF92B30668FF200382F4493B0A5323428781D0B993E19C51') { throw 'P4_CLIENT_CHANGED' }
if ((Get-FileHash -LiteralPath $run.rollback -Algorithm SHA256).Hash -ne 'B48BD850E4A3CBBF44022CFEEF82E11272958F3052C8BE8748904DEF3BCFCF12') { throw 'P4_ROLLBACK_CHANGED' }
if ((Get-FileHash -LiteralPath $run.injector -Algorithm SHA256).Hash -ne '2CC928A99683282559803800E17F6506D284AACC5ED0DCDEF683627713279BE9') { throw 'P4_INJECTOR_CHANGED' }
if ($dll -match '[^\x20-\x7e]') { throw 'P4_ASCII_PATH_REQUIRED' }
$wechat=Get-Process -Id $WeChatProcessId
if ($wechat.ProcessName -ne 'WeChat') { throw 'P4_WRONG_PROCESS' }
$started=$wechat.StartTime.ToUniversalTime().Ticks
$modules=@($wechat.Modules)
if (@($modules | Where-Object { $_.ModuleName -ieq 'wxhelper.dll' }).Count -ne 0) { throw 'P4_OLD_HELPER_RESIDENT_CLOSE_WECHAT_FIRST' }
$clientModule=@($modules | Where-Object { $_.ModuleName -ieq 'WeChatWin.dll' })
if ($clientModule.Count -ne 1 -or $clientModule[0].FileName -ine $run.client) { throw 'P4_WRONG_CLIENT_MODULE' }
$listeners=@(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in @(19088,19188) })
if ($listeners.Count -ne 0) { throw 'P4_PORT_OCCUPIED' }
Set-Location -LiteralPath $run.workspace
& node scripts/wxhelper-receive-only-client.mts verify $PSScriptRoot $run.environment
if ($LASTEXITCODE -ne 0) { throw 'P4_VERIFY_FAILED' }
$stateFile=Join-Path $PSScriptRoot 'owner-state.json'
if (Test-Path -LiteralPath $stateFile) { throw 'P4_ATTEMPT_ALREADY_RECORDED_NO_RETRY' }
if ($CheckOnly) { Write-Host 'P4_ATTACH_PREFLIGHT_OK'; return }
$state=@{process=$WeChatProcessId;startedTicks=$started;attempted=$true;createdAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json
$stateStream=[IO.File]::Open($stateFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $stateBytes=[Text.Encoding]::UTF8.GetBytes($state); $stateStream.Write($stateBytes,0,$stateBytes.Length) } finally { $stateStream.Dispose() }
& $run.injector -I $WeChatProcessId -p $dll *> (Join-Path $PSScriptRoot 'human-injection.log')
if ($LASTEXITCODE -ne 0) { throw 'P4_INJECTION_FAILED_CLOSE_WECHAT_NO_RETRY' }
$listeners=@()
for ($i=0; $i -lt 24; $i++) {
  $listeners=@(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq 19188 })
  if ($listeners.Count -gt 0) { break }
  Start-Sleep -Milliseconds 250
}
if ($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne $WeChatProcessId -or $listeners[0].LocalAddress -ne '127.0.0.1') { throw 'P4_LISTENER_NOT_OWNED_CLOSE_WECHAT' }
$current=Get-Process -Id $WeChatProcessId
if ($current.StartTime.ToUniversalTime().Ticks -ne $started) { throw 'P4_PROCESS_CHANGED' }
$loaded=@($current.Modules | Where-Object { $_.ModuleName -ieq 'wxhelper.dll' })
if ($loaded.Count -ne 1 -or $loaded[0].FileName -ine $dll) { throw 'P4_LOADED_MODULE_MISMATCH' }
& node scripts/wxhelper-receive-only-client.mts status $PSScriptRoot $run.environment
if ($LASTEXITCODE -ne 0) { throw 'P4_PROTOCOL_FAILED_CLOSE_WECHAT' }
Write-Host 'P4_LOADED_RECEIVE_ONLY_HOOK_NOT_STARTED'
