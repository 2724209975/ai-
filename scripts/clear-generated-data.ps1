$ErrorActionPreference='Stop'
$taskWorkspace=Split-Path -Parent $PSScriptRoot
$taskTrialBase=Join-Path $env:LOCALAPPDATA 'ChatAgentTrial'
$taskPointer=Get-Content -LiteralPath (Join-Path $taskWorkspace '.local-prerelease/qq-candidate-current.json') -Raw | ConvertFrom-Json
$taskManifest=Get-Content -LiteralPath $taskPointer.manifest -Raw | ConvertFrom-Json
$taskRemoved=0
function Remove-OwnedData([string]$Path,[string]$Root){
 if(!(Test-Path -LiteralPath $Path)){return}
 $taskResolved=(Resolve-Path -LiteralPath $Path).Path
 $taskAllowed=[IO.Path]::GetFullPath($Root).TrimEnd('\')+'\'
 if(!$taskResolved.StartsWith($taskAllowed,[StringComparison]::OrdinalIgnoreCase)){throw '清理路径超出指定目录'}
 $taskItem=Get-Item -LiteralPath $taskResolved -Force
 if($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint){throw '清理目标包含链接，已停止'}
 if($taskItem.PSIsContainer){
  $taskLinks=@(Get-ChildItem -LiteralPath $taskResolved -Recurse -Force | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint})
  if($taskLinks.Count){throw '清理目录包含链接，已停止'}
  Remove-Item -LiteralPath $taskResolved -Recurse -Force
 }else{Remove-Item -LiteralPath $taskResolved -Force}
 $script:taskRemoved++
}
foreach($taskName in @('output\p6','output\playwright','test-results','output\android\link-ux','output\android\device-test-report','output\android\multimodal-device-test-report','output\android\multimodal-unit-test-report','output\android\unit-test-report')){Remove-OwnedData (Join-Path $taskWorkspace $taskName) $taskWorkspace}
foreach($taskFile in @(Get-ChildItem -LiteralPath (Join-Path $taskWorkspace 'output\android') -File)){
 if($taskFile.Extension -in @('.png','.jpg','.jpeg','.xml','.json','.jsonl') -and $taskFile.Name -notin @('project-cleanup-result.json','project-release-checks.json')){Remove-OwnedData $taskFile.FullName $taskWorkspace}
}
foreach($taskFile in @(Get-ChildItem -LiteralPath (Join-Path $taskWorkspace 'output\rewrite') -File)){
 if($taskFile.Extension -in @('.png','.jpg','.jpeg') -or $taskFile.Name -eq 'qq-feedback-browser-fixture.json'){Remove-OwnedData $taskFile.FullName $taskWorkspace}
}
foreach($taskDir in @(Get-ChildItem -LiteralPath (Join-Path $taskWorkspace 'output\rewrite') -Directory | Where-Object {$_.Name -like 'quality-settings-ui-*'})){Remove-OwnedData $taskDir.FullName $taskWorkspace}
foreach($taskDir in @('phone-upgrade-backups','deployment-backups')){Remove-OwnedData (Join-Path $taskTrialBase $taskDir) $taskTrialBase}
$taskPrivate=Join-Path $taskManifest.prereleaseRoot 'private'
foreach($taskDir in @(Get-ChildItem -LiteralPath $taskPrivate -Directory | Where-Object {$_.Name -like 'qq-candidate-*' -or $_.Name -like 'real-model-*'})){
 foreach($taskChild in @(Get-ChildItem -LiteralPath $taskDir.FullName -Force)){
  $taskProtected=$taskChild.Name -in @('calls.jsonl','manifest.json','runtime.json','final.json','authorization.json','budget-continuity.json','quality-model.json','mobile-link-config.json','owner-sessions','guardian.json','owner-stop.json')
  if(!$taskProtected){Remove-OwnedData $taskChild.FullName $taskPrivate}
 }
}
Write-Output (@{removedTargets=$taskRemoved;accountingAndConfigurationPreserved=$true} | ConvertTo-Json -Compress)
