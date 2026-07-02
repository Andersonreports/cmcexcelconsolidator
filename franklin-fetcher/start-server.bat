@echo off
title Franklin Fetcher Server
echo ==========================================
echo   Franklin Fetcher Server
echo ==========================================
echo.

:: Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo ERROR: Node.js is not installed.
  echo.
  echo Download and install from:  https://nodejs.org
  echo Then run this file again.
  echo.
  pause
  exit /b 1
)

cd /d "%~dp0"

:: Install dependencies if needed
if not exist node_modules (
  echo Installing dependencies (first run only^)...
  call npm install
  if %ERRORLEVEL% NEQ 0 ( echo npm install failed. & pause & exit /b 1 )
  echo.
  echo Installing Chromium browser...
  call npx playwright install chromium
  if %ERRORLEVEL% NEQ 0 ( echo Playwright install failed. & pause & exit /b 1 )
  echo.
)

echo Starting server on http://localhost:3001 ...
echo.
echo  - Keep this window open while using CMC Excel Consolidator.
echo  - Franklin values will fill in automatically when you upload a VarSeq file.
echo  - Close this window to stop the server.
echo.

node server.js

pause
