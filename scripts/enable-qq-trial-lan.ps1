[CmdletBinding()]
param([string]$Manifest)
$ErrorActionPreference = 'Stop'
$trialWorkspace = Split-Path $PSScriptRoot -Parent
if (-not $Manifest) {
    $trialPointer = Get-Content -LiteralPath (Join-Path $trialWorkspace '.local-prerelease/qq-candidate-current.json') -Raw | ConvertFrom-Json
    $Manifest = $trialPointer.manifest
}
$trialConfig = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
$trialRuntime = Get-Content -LiteralPath (Join-Path $trialConfig.root 'runtime.json') -Raw | ConvertFrom-Json
if ($trialConfig.ownerAuthorized -ne $true -or $trialConfig.automaticSendAuthorized -ne $false -or $trialRuntime.automaticSendEnabled -ne $false -or $trialRuntime.dispatchWorker -ne $false -or $trialConfig.persistent -ne $true) { throw 'QQ trial scope invalid.' }
$trialAddress = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -eq $trialConfig.workbenchLanHost }
if (@($trialAddress).Count -ne 1 -or $trialAddress.IPAddress -notmatch '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -or $trialConfig.workbenchPort -lt 1024 -or $trialConfig.workbenchPort -gt 65535) { throw 'LAN address or port invalid.' }
$trialPrincipal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $trialPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '请在管理员 PowerShell 中运行本脚本；普通权限不能修改 Windows 防火墙。' }
$trialNode = (Get-Command node -CommandType Application).Source
$trialRuleName = 'PersonalChatAgent-QQ-Candidate-LAN'
$trialRuleArgs = @{ Enabled='True'; Direction='Inbound'; Action='Allow'; Profile=@('Private','Public'); Protocol='TCP'; LocalPort=$trialConfig.workbenchPort; LocalAddress=$trialAddress.IPAddress; RemoteAddress='LocalSubnet'; InterfaceAlias=$trialAddress.InterfaceAlias; Program=$trialNode; EdgeTraversalPolicy='Block' }
if (Get-NetFirewallRule -Name $trialRuleName -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule -Name $trialRuleName @trialRuleArgs | Out-Null
} else {
    New-NetFirewallRule -Name $trialRuleName -DisplayName 'QQ 候选工作台（本机局域网）' @trialRuleArgs | Out-Null
}
Write-Output ('已允许同一局域网访问 ' + $trialRuntime.lanUrl + '；仍需工作台密码登录。')
