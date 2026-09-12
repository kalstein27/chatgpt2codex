@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Build-And-Verify-Portable.ps1" %*
set "exitCode=%ERRORLEVEL%"
echo.
pause
exit /b %exitCode%
