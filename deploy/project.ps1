param([ValidateSet('start','stop','restart','status','update')][string]$Operation='start')
$ErrorActionPreference='Stop'
$taskProjectRoot=Split-Path -Parent $PSScriptRoot
$taskNode=(Get-Command node -ErrorAction Stop).Source
Push-Location -LiteralPath $taskProjectRoot
try {
 $taskRaw=& $taskNode (Join-Path $taskProjectRoot 'scripts/project-control.mts') $Operation
 if($LASTEXITCODE -ne 0){throw '项目操作未完成，请查看上面的错误说明。'}
 $taskResult=$taskRaw | ConvertFrom-Json
 if($Operation -eq 'status'){
  Add-Type -AssemblyName System.Windows.Forms
  $taskState=if($taskResult.running){'工作台运行中'}else{'工作台未启动'}
  [System.Windows.Forms.MessageBox]::Show(($taskState+"`n电脑版本："+$taskResult.release.desktopVersion+"`n手机推荐版本："+$taskResult.release.androidVersion+"`n自动发送：关闭"),'聊天助手运行状态') | Out-Null
 }
 if($Operation -in @('start','restart','update')){
  for($taskAttempt=0;$taskAttempt -lt 30;$taskAttempt++){
   $taskStatus=& $taskNode (Join-Path $taskProjectRoot 'scripts/project-control.mts') status | ConvertFrom-Json
   if($taskStatus.running){Start-Process -FilePath $taskStatus.workbenchUrl;break}
   Start-Sleep -Seconds 1
  }
 }
 $taskResult | ConvertTo-Json -Depth 5
} finally {Pop-Location}
