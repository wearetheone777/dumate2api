@echo off
setlocal enabledelayedexpansion
chcp 65001 > nul
title dumate2api - gateway + admin (9080/9081)
echo ================================================
echo  dumate2api - single window
echo    Gateway 9080
echo    Admin   9081  (watching 9080)
echo ================================================
echo.
echo  This script uses the working tree in this repo.
echo  Both ports are the built-in defaults -- no env override needed.
echo.
rem KEEP THIS FILE PURE ASCII.
rem cmd.exe parses .bat by byte offset; under chcp 65001 a multi-byte char can
rem desync it and get part of a line executed as a command (non-deterministic).
cd /d "%~dp0"
set NOPAUSE=%1

rem ---------------------------------------------------------------------------
rem Preflight: make sure 9080/9081 are free before starting anything.
rem Why this exists: if the gateway cannot bind 9080 it exits at once, and the
rem cleanup at the bottom of this script (which runs when the gateway exits)
rem then kills the admin we just started on 9081 -- leaving BOTH ports dead and
rem no obvious reason why. A leftover node from a previous run is the usual
rem cause.
rem
rem Policy: a listener that is node.exe is our own leftover -> kill it and
rem continue. Anything else is not ours -> abort WITHOUT killing, so we never
rem silently take down a process we did not start.
rem ---------------------------------------------------------------------------
call :preflight 9080
if errorlevel 1 goto :abort
call :preflight 9081
if errorlevel 1 goto :abort

rem Admin runs in the background of THIS console (`start /b`), so its output
rem interleaves here instead of taking a second window. Both processes share
rem the console, so closing this window stops both.
echo Starting admin (9081, watching 9080) in background...
set DUMATE_ADMIN_PORT=9081
set DUMATE_ADMIN_GATEWAY_PORT=9080
start /b "" node src\admin\server.js
rem Wait for admin to bind 9081 so its startup line lands before the gateway's.
rem Use ping, not `timeout`: under a POSIX shell (Git Bash / MSYS) `timeout` is
rem shadowed by the GNU coreutils one, which rejects `/t` and exits non-zero.
ping -n 3 127.0.0.1 > nul 2>&1

echo Starting gateway (9080) in foreground...
echo.
echo   Admin:  http://127.0.0.1:9081
echo   Gateway: http://127.0.0.1:9080
echo.
echo   Ctrl+C or close this window to stop both.
echo ================================================
echo.

set DUMATE2API_PORT=9080
rem Enforce registered API keys (keys.json). Remove this line to allow keyless access.
set DUMATE_REQUIRE_KEY=1
node src\server.js

echo.
echo Gateway exited. Stopping admin...
rem Kill the admin by the port it listens on. Closing the window would also
rem take it down, but reaching here (Ctrl+C / gateway crash) would otherwise
rem leave it orphaned on 9081. Reuse :preflight so we only ever kill node.exe
rem -- never an unrelated process that happens to hold 9081.
call :preflight 9081
echo Done.
if /i "%NOPAUSE%"=="nopause" exit /b 0
pause
exit /b 0

:abort
rem Reached when a port is held by a process that is not our own node.exe.
rem Nothing has been killed at this point, and nothing has been started.
echo.
echo ================================================
echo  ABORT: 9080/9081 busy, held by a non-node process.
echo  Refusing to start (nothing was killed).
echo.
echo  Inspect who holds the port:
echo      netstat -ano ^| findstr ":9080 :9081"
echo  Then stop it yourself:
echo      taskkill /F /PID ^<pid^>
echo ================================================
if /i "%NOPAUSE%"=="nopause" exit /b 1
pause
exit /b 1

:preflight
rem Returns 0 if port %1 is free -- killing our own leftover node.exe first if
rem that is what holds it. Returns 1 if a process that is NOT node.exe holds it.
rem Must stay free of unescaped ^< ^> ^| characters (see the ASCII note above).
setlocal enabledelayedexpansion
set "PORT=%~1"
set "KILLED=0"
set "FOREIGN=0"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":%PORT% "') do (
    set "PID=%%a"
    set "IMAGENAME="
    for /f "tokens=1" %%n in ('tasklist /FI "PID eq !PID!" /FO TABLE /NH 2^>nul') do (
        if not defined IMAGENAME set "IMAGENAME=%%n"
    )
    if /i "!IMAGENAME!"=="node.exe" (
        echo   [preflight] port %PORT%: stopping our leftover node.exe PID !PID!
        taskkill /F /PID !PID! /T >nul 2>&1
        set "KILLED=1"
    ) else (
        echo   [preflight] port %PORT%: held by !IMAGENAME! PID !PID! - NOT ours, leaving it alone
        set "FOREIGN=1"
    )
)
if "!FOREIGN!"=="1" exit /b 1
if "!KILLED!"=="1" (
    rem Give the OS a moment to release the socket before we try to bind it.
    ping -n 3 127.0.0.1 > nul 2>&1
)
exit /b 0
