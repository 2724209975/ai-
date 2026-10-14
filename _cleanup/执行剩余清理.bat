@echo off
chcp 65001 >nul 2>&1
title C drive cleanup - remaining items

set "FLAG=C:\1\ai_cleanup_out\_launched.flag"
set "PS1=C:\1\ai代聊\_cleanup\cleanup-remaining.ps1"

if exist "%FLAG%" goto runelevated

echo Requesting administrator rights - please click YES in the UAC dialog...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~s0' -Verb RunAs"
exit /b

:runelevated
del /f /q "%FLAG%" >nul 2>&1
echo Running as administrator.
echo Log will be written to C:\1\ai_cleanup_out\remaining-run.log
echo This may take 10 to 30 minutes (200k+ files). Please keep this window open.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
echo.
echo Done. Press any key to close.
pause >nul
