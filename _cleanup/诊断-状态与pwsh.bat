@echo off
chcp 65001 >nul 2>&1
title DSH - status and pwsh diagnostic
echo ============================================================
echo   Please send me everything below
echo ============================================================
echo.
echo [1] Remaining cleanup targets - do they still exist?
powershell.exe -NoProfile -Command "$D=[char]36; foreach($t in @(('C:\'+$D+'WINDOWS.~BT'),('C:\'+$D+'Windows.~WS'),('C:\'+$D+'SysReset'),'C:\ESD','C:\XboxGames','C:\Windows\SoftwareDistribution\Download')){ if(Test-Path -LiteralPath $t){ $s=Get-ChildItem -LiteralPath $t -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum; Write-Host ('  EXISTS  {0,8:N2} GB {1,7} files  {2}' -f ($s.Sum/1GB),$s.Count,$t) } else { Write-Host ('  GONE                                ' + $t) } }"
echo.
echo [2] WindowsApps pwsh alias:
dir "C:\Users\a4151\AppData\Local\Microsoft\WindowsApps\pwsh*" 2>nul
if errorlevel 1 echo   NOT FOUND - the alias is missing
echo.
echo [3] Real PowerShell 7 installations:
if exist "C:\Program Files\PowerShell\7\pwsh.exe" (echo   FOUND: C:\Program Files\PowerShell\7\pwsh.exe) else (echo   not installed in Program Files\PowerShell\7)
echo.
echo [4] PowerShell Store package:
powershell.exe -NoProfile -Command "Get-AppxPackage -Name Microsoft.PowerShell* | Select-Object Name,Version,Status,InstallLocation | Format-List"
echo.
echo [5] Free space:
powershell.exe -NoProfile -Command "'  {0:N2} GB free on C:' -f ((Get-PSDrive C).Free/1GB)"
echo.
echo [6] Key data still intact (should all say OK):
powershell.exe -NoProfile -Command "foreach($p in @('C:\Users\a4151\Documents\WeChat Files','C:\Users\a4151\xwechat_files','C:\1\ai代聊','C:\2','C:\hiberfil.sys','C:\pagefile.sys')){ if(Test-Path -LiteralPath $p){Write-Host ('  OK    ' + $p)}else{Write-Host ('  MISSING  ' + $p)} }"
echo.
echo ============================================================
echo   Copy everything above and send it to me.
echo ============================================================
pause
