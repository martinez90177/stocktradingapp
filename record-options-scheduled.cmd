@echo off
REM Wrapper used by Task Scheduler. Keeps a rolling log so a session that
REM failed overnight leaves evidence instead of vanishing.
setlocal
set "HERE=%~dp0"
cd /d "%HERE%"
if not exist "logs" mkdir "logs"

set "NODE=node"
if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"

echo. >> "logs\options.log"
echo ===== %DATE% %TIME% ===== >> "logs\options.log"
"%NODE%" "%HERE%tools\record-options.mjs" >> "logs\options.log" 2>&1
set "CODE=%ERRORLEVEL%"
echo exit code %CODE% >> "logs\options.log"
exit /b %CODE%
