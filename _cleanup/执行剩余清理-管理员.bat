@echo off
chcp 65001 >nul 2>&1
title C drive cleanup - remaining items

net session >nul 2>&1
if %errorlevel%==0 goto :run

echo Requesting administrator rights - please click YES in the UAC dialog...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~s0' -Verb RunAs"
exit /b

:run
echo Running as administrator. A log is written to C:\1\ai_cleanup_out\
echo This can take 10 to 30 minutes (200k+ files). Please do not close the window.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~sdp0cleanup-remaining.ps1"
echo.
pause
