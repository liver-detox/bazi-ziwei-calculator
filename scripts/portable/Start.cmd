@echo off
setlocal
chcp 65001 >nul
set "NODE_OPTIONS="
set "NODE_PATH="
set "CHECK_ONLY="
if not "%~2"=="" exit /b 2
if not "%~1"=="" if /i not "%~1"=="--check" exit /b 2
if /i "%~1"=="--check" set "CHECK_ONLY=--check"
if not exist "%~dp0runtime\node.exe" goto missing
"%~dp0runtime\node.exe" "%~dp0app\portable.mjs" %CHECK_ONLY%
set "EXIT_CODE=%errorlevel%"
if defined CHECK_ONLY exit /b %EXIT_CODE%
if not "%EXIT_CODE%"=="0" (
  echo Unable to start. Extract the entire ZIP to a writable folder and try again.
  pause
)
exit /b %EXIT_CODE%
:missing
echo Missing bundled runtime. Extract the entire ZIP before starting.
if not defined CHECK_ONLY pause
exit /b 1
