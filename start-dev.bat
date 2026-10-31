@echo off
setlocal enabledelayedexpansion
chcp 65001 > nul
title dumate2api - dev (9082/9083)
echo ================================================
echo  Dev instance - single window
echo    Gateway 9082  (stable runs on 9080, unaffected)
echo    Admin   9083
echo ================================================
echo.
echo  This script uses the working tree in this repo (changes often).
echo  For the stable snapshot use stable\start-stable.bat (port 9080).
echo.
rem KEEP THIS FILE PURE ASCII -- see the long note in stable\start-stable.bat.
rem cmd.exe parses .bat by byte offset; under chcp 65001 a multi-byte char can
rem desync it and get part of a line executed as a command (non-deterministic).
cd /d "%~dp0"
set NOPAUSE=%1

rem ---------------------------------------------------------------------------
rem Preflight: make sure 9082/9083 are free before starting anything.
rem Why this exists: if the gateway cannot bind 9082 it exits at once, and the
rem cleanup at the bottom of this script (which runs when the gateway exits)
rem then kills the admin we just started on 9083 -- leaving BOTH ports dead and
rem no obvious reason why. A leftover node from a previous run is the usual
rem cause (stop.bat only targets 9080, so dev leftovers never get cleaned).
rem
rem Policy: a listener that is node.exe is our own leftover -> kill it and
rem continue. Anything else is not ours -> abort WITHOUT killing, so we never
rem silently take down a process we did not start.
rem ---------------------------------------------------------------------------
call :preflight 9082
if errorlevel 1 goto :abort
call :preflight 9083
if errorlevel 1 goto :abort

rem Admin runs in the background of THIS console (`start /b`), so its output
rem interleaves here instead of taking a second window. Both processes share
rem the console, so closing this window stops both.
echo Starting admin (9083, watching 9082) in background...
set DUMATE_ADMIN_PORT=9083
set DUMATE_ADMIN_GATEWAY_PORT=9082
start /b "" node src\admin\server.js
rem Wait for admin to bind 9083 so its startup line lands before the gateway's.
rem Use ping, not `timeout`: under a POSIX shell (Git Bash / MSYS) `timeout` is
rem shadowed by the GNU coreutils one, which rejects `/t` and exits non-zero.
ping -n 3 127.0.0.1 > nul 2>&1

echo Starting gateway (9082) in foreground...
echo.
echo   Dev admin:    http://127.0.0.1:9083
echo   Stable admin: http://127.0.0.1:9081 (if running)
echo   Port 9080 is not touched.
echo.
echo   Ctrl+C or close this window to stop both.
echo ================================================
echo.

set DUMATE2API_PORT=9082
rem Enforce registered API keys (keys.json). Remove this line to allow keyless access.
set DUMATE_REQUIRE_KEY=1
node src\server.js

echo.
echo Gateway exited. Stopping admin...
rem Kill the admin by the port it listens on. Closing the window would also
rem take it down, but reaching here (Ctrl+C / gateway crash) would otherwise
rem leave it orphaned on 9083. Reuse :preflight so we only ever kill node.exe
rem -- never an unrelated process that happens to hold 9083.
call :preflight 9083
echo Done.
if /i "%NOPAUSE%"=="nopause" exit /b 0
pause
exit /b 0

:abort
rem Reached when a port is held by a process that is not our own node.exe.
rem Nothing has been killed at this point, and nothing has been started.
echo.
echo ================================================
echo  ABORT: 9082/9083 busy, held by a non-node process.
echo  Refusing to start (nothing was killed).
echo.
echo  Inspect who holds the port:
echo      netstat -ano ^| findstr ":9082 :9083"
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
