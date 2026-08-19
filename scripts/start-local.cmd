@echo off
setlocal

set "SCRIPT_DIRECTORY=%~dp0"
cd /d "%SCRIPT_DIRECTORY%.." || exit /b 1

if not "%~2"=="" (
  echo Usage: scripts\start-local.cmd [--check]
  exit /b 2
)

if not "%~1"=="" if /i not "%~1"=="--check" (
  echo Usage: scripts\start-local.cmd [--check]
  exit /b 2
)

if /i "%~1"=="--check" set "CHECK_ONLY=1"

where node >nul 2>&1 || (
  echo Unable to start: Node.js 24 or newer is required.
  exit /b 1
)

for /f %%V in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR_VERSION=%%V"
if not defined NODE_MAJOR_VERSION (
  echo Unable to start: Node.js 24 or newer is required.
  exit /b 1
)

set /a NODE_MAJOR_VERSION+0 >nul 2>&1
if errorlevel 1 (
  echo Unable to start: Node.js 24 or newer is required.
  exit /b 1
)

if %NODE_MAJOR_VERSION% LSS 24 (
  echo Unable to start: Node.js 24 or newer is required.
  exit /b 1
)

if not exist "node_modules\" (
  echo Unable to start: dependencies are not installed. Run npm ci first.
  exit /b 1
)

call npm run build
if errorlevel 1 exit /b %errorlevel%

if defined CHECK_ONLY exit /b 0

echo Starting Cyber Sage Bazi and Ziwei Calculator...
call npm start
exit /b %errorlevel%
