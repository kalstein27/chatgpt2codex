@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Repair-Node-Npm.ps1" -RebuildPortable %*
set "exitCode=%ERRORLEVEL%"
echo.
pause
exit /b %exitCode%
