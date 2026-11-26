@echo off
setlocal
cd /d "%~dp0"
where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm was not found. Install Node.js and pnpm, then try again.
  pause
  exit /b 1
)
echo Starting RPA Browser. Use the NEW browser window that opens.
echo Keep this terminal open while using RPA. Press Ctrl+C to stop.
call pnpm start
if errorlevel 1 pause
