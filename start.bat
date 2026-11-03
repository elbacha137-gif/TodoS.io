@echo off
title Todo Reminder
chcp 65001 >nul
cd /d "%~dp0"

if not exist data mkdir data

start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:4321"

echo.
echo   Starting Todo Reminder...
echo   Keep this window open while you use the app.
echo   Press Ctrl+C to stop.
echo.

node server.js
pause
