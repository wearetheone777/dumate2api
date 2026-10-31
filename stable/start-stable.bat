@echo off
chcp 65001 > nul
title dumate2api - stable (9080)
echo ================================================
echo  Stable gateway - port 9080
echo  Serves cc-switch / Codex / Claude Code
echo ================================================
echo.
echo  This is snapshot code; it does NOT follow dev changes.
echo  See SNAPSHOT_FROM.txt. For development use start-dev.bat (9082).
echo.
cd /d "%~dp0"
set NOPAUSE=%1
set DUMATE2API_PORT=9080
rem Enforce registered API keys (keys.json). External clients must send their dmk_ key.
set DUMATE_REQUIRE_KEY=1
rem ---------------------------------------------------------------------------
rem KEEP THIS FILE PURE ASCII. Do not add non-ASCII text here.
rem
rem cmd.exe reads a .bat file by BYTE OFFSET. Under `chcp 65001` (UTF-8) a
rem multi-byte character desynchronises that offset, so a line can be read
rem from the wrong position and its tail executed as a command. It is
rem NON-DETERMINISTIC: the same file and command failed once and succeeded
rem twice out of three runs. Real damage observed -- a garbled fragment was
rem run as a command and spawned a stray `claude.exe` session.
rem
rem Note this is NOT fixed by chcp: the codepage must be set before the file
rem is parsed, and the chcp line is itself part of the file being parsed.
rem Hence the rule is ASCII-only, not "set the right codepage".
rem
rem The chcp below is kept on purpose: it makes the Node child process print
rem Chinese log lines correctly. Removing it would break the gateway logs.
rem ---------------------------------------------------------------------------
rem Data dir must point at <repo>/data, shared with the dev instance (account
rem pool is shared on purpose). Without it the gateway falls back to
rem stable/data, which holds no credentials -- qwenwork/traework then fail.
set DUMATE_ADMIN_DATA=%~dp0..\data
node src\server.js
echo.
echo Gateway exited.
rem nopause lets scripts start this without the window blocking on a keypress.
if /i "%NOPAUSE%"=="nopause" exit /b 0
pause
