[CmdletBinding()]
param([ValidateRange(1, 65535)][int]$Port = 8787)
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script in an Administrator PowerShell window.'
}
# Private profile and directly connected subnets only. Never open DB/bridge ports.
$ruleName = "PersonalChatAgent-LAN-$Port"
$existing = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
if ($existing) {
    Set-NetFirewallRule -Name $ruleName -Enabled True -Direction Inbound -Action Allow -Profile Private -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet -LocalAddress Any -Program Any -Service Any -EdgeTraversalPolicy Block | Out-Null
} else {
    New-NetFirewallRule -Name $ruleName -DisplayName "Personal Chat Agent LAN ($Port)" -Enabled True -Direction Inbound -Action Allow -Profile Private -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet -EdgeTraversalPolicy Block | Out-Null
}
Write-Output "Allowed TCP $Port on Private networks from LocalSubnet."
