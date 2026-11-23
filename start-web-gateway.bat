@echo off
chcp 65001 > nul
title dumate2api - web gateway (9084)
echo ================================================
echo  Multi-account gateway - port 9084
echo ================================================
echo.
echo  Runs models with the web credentials added under Account Management,
echo  rotating across multiple accounts.
echo  Does NOT depend on the desktop client; independent from 9080/9081.
echo.
echo  Check accounts first: http://127.0.0.1:9081
echo.
rem KEEP THIS FILE PURE ASCII -- see the long note in start-dev.bat.
rem cmd.exe parses .bat by byte offset; under chcp 65001 a multi-byte char can
rem desync it and get part of a line executed as a command (non-deterministic).
cd /d "%~dp0"
set DUMATE_WEB_GATEWAY_PORT=9084
node src\web-gateway.js
pause
