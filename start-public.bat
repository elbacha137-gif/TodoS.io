@echo off
chcp 65001 >nul
cd /d "%~dp0"
title TodoS.io - public link
node scripts\public.js
pause
