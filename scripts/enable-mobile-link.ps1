[CmdletBinding()]
param([ValidateRange(1,65535)][int]$Port=8791,[string]$Address,[switch]$OpenFirewall)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path $PSScriptRoot -Parent
$taskDirectory=Join-Path $taskRoot '.local-mobile-link'
New-Item -ItemType Directory -Force -Path $taskDirectory | Out-Null
if (!$Address) {
  $Address=Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -and $_.InterfaceAlias -notmatch 'vEthernet|Virtual|Loopback'} | Sort-Object InterfaceMetric | Select-Object -First 1 -ExpandProperty IPAddress
}
if(!$Address -or $Address -notmatch '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)'){throw 'Connect to private Wi-Fi/Ethernet or pass -Address with the LAN IPv4 address.'}
$taskCertificate=Join-Path $taskDirectory 'certificate.pem'
$taskKey=Join-Path $taskDirectory 'private-key.pem'
if(!(Test-Path -LiteralPath $taskCertificate) -or !(Test-Path -LiteralPath $taskKey)){
  $taskOpenSsl=Get-Command openssl -ErrorAction SilentlyContinue
  $taskOpenSslPath=if($taskOpenSsl){$taskOpenSsl.Source}else{'C:\Program Files\Git\usr\bin\openssl.exe'}
  if(!(Test-Path -LiteralPath $taskOpenSslPath)){throw 'OpenSSL not found; install Git for Windows or add openssl to PATH.'}
  & $taskOpenSslPath req -x509 -newkey rsa:2048 -sha256 -nodes -days 825 -subj '/CN=PersonalReplyAssistant' -keyout $taskKey -out $taskCertificate 2>$null
  if($LASTEXITCODE -ne 0){throw 'Unable to create the local pairing certificate.'}
}
@{MOBILE_LINK_ENABLED='1';MOBILE_LINK_ORIGIN="https://${Address}:$Port";MOBILE_LINK_CERT=$taskCertificate;MOBILE_LINK_KEY=$taskKey}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $taskDirectory 'config.json') -Encoding UTF8
if($OpenFirewall){ & (Join-Path $PSScriptRoot 'enable-lan-access.ps1') -Port $Port }
Write-Output "Mobile link configured: https://${Address}:$Port"
Write-Output 'Apply migrations, then restart the project. Open More > Mobile link in the desktop workspace.'
