@echo off
echo ============================================
echo  Franklin Classification Fetcher
echo ============================================
echo.

:: Check Node.js is installed
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo ERROR: Node.js is not installed.
  echo.
  echo Please install Node.js from:  https://nodejs.org
  echo Download the LTS version, install it, then run this file again.
  echo.
  pause
  exit /b 1
)

:: Install dependencies if not already done
if not exist node_modules (
  echo Installing dependencies ^(first run only, takes ~1 minute^)...
  call npm install
  if %ERRORLEVEL% NEQ 0 ( echo npm install failed. & pause & exit /b 1 )
  echo.
  echo Installing Chromium browser...
  call npx playwright install chromium
  if %ERRORLEVEL% NEQ 0 ( echo Playwright install failed. & pause & exit /b 1 )
  echo.
)

:: Run the fetcher
echo Drag your Listed Variant Excel file(s) onto this window, then press Enter.
echo Or just press Enter to process all .xlsx files in THIS folder.
echo.
set /p FILES="Excel file path(s) [Enter for auto]: "

if "%FILES%"=="" (
  node fetch-franklin.js
) else (
  node fetch-franklin.js %FILES%
)

echo.
pause
