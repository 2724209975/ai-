@echo off
chcp 65001 >nul 2>&1
title DSH - pwsh alias diagnostic
echo ============================================================
echo   DSH environment diagnostic - please send me this output
echo ============================================================
echo.
echo [1] WindowsApps pwsh alias:
dir "C:\Users\a4151\AppData\Local\Microsoft\WindowsApps\pwsh*" 2>nul
if errorlevel 1 echo   NOT FOUND - the alias is missing
echo.
echo [2] Real PowerShell 7 installations:
if exist "C:\Program Files\PowerShell\7\pwsh.exe" (echo   FOUND: C:\Program Files\PowerShell\7\pwsh.exe) else (echo   not in C:\Program Files\PowerShell\7)
if exist "C:\Program Files\PowerShell\8\pwsh.exe" (echo   FOUND: C:\Program Files\PowerShell\8\pwsh.exe) else (echo   not in C:\Program Files\PowerShell\8)
echo.
echo [3] PowerShell Store package:
powershell.exe -NoProfile -Command "Get-AppxPackage -Name Microsoft.PowerShell* | Select-Object Name,Version,InstallLocation | Format-List; Get-AppxPackage -Name Microsoft.WindowsTerminal | Select-Object Name,Version | Format-List"
echo.
echo [4] WindowsApps folder contents (pwsh-related):
powershell.exe -NoProfile -Command "Get-ChildItem 'C:\Users\a4151\AppData\Local\Microsoft\WindowsApps' -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*pwsh*' -or $_.Name -like '*PowerShell*' } | Select-Object Name,Length,LinkType,Target | Format-List"
echo.
echo [5] App execution alias registry state:
powershell.exe -NoProfile -Command "Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\AppModelUnlock' -ErrorAction SilentlyContinue | Format-List"
echo.
echo [6] Free space:
powershell.exe -NoProfile -Command "'{0:N2} GB free on C:' -f ((Get-PSDrive C).Free/1GB)"
echo.
echo ============================================================
echo   Copy everything above and send it to me.
echo ============================================================
pause
