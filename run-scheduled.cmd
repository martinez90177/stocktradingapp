@echo off
REM Wrapper used by Task Scheduler. Keeps a rolling log so a failed overnight
REM run leaves evidence instead of vanishing.
setlocal
set "HERE=%~dp0"
cd /d "%HERE%"
if not exist "logs" mkdir "logs"

set "NODE=node"
if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"

echo. >> "logs\run.log"
echo ===== %DATE% %TIME% ===== >> "logs\run.log"
"%NODE%" "%HERE%run.ts" >> "logs\run.log" 2>&1
set "CODE=%ERRORLEVEL%"
echo exit code %CODE% >> "logs\run.log"

REM Keep the futures practice library growing. Yahoo serves only seven days of
REM one-minute bars, so every day this misses is a day that can't be recovered
REM later. It never changes the exit code above.
echo -- recording futures bars -- >> "logs\run.log"
"%NODE%" "%HERE%tools\record-futures.mjs" >> "logs\run.log" 2>&1
exit /b %CODE%
