@echo off
setlocal
set "outputDir=%~dp0..\build\windows-portable-next"
if not exist "%outputDir%" mkdir "%outputDir%"
set "cmdLog=%outputDir%\resume-portable-verify.cmd.log"
echo [chatgpt2codex] Resume portable verification started > "%cmdLog%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Resume-Portable-Verify.ps1" %* >> "%cmdLog%" 2>&1
set "exitCode=%ERRORLEVEL%"
echo.
type "%cmdLog%"
echo.
echo [chatgpt2codex] Diagnostic log: %cmdLog%
pause
exit /b %exitCode%