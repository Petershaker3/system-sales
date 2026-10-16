@echo off
REM ---------------------------------------------------------------------------
REM npm.bat shim.
REM
REM Gradle's Tauri Rust plugin spawns the literal command "npm.bat" on Windows.
REM Node 24 no longer ships that file: C:\Program Files\nodejs contains only
REM `npm`, `npm.cmd` and `npm.ps1`. The build therefore failed with
REM
REM     Execution failed for task ':app:rustBuildArm64Debug'
REM     > A problem occurred starting process 'command 'npm.bat''
REM
REM This forwards to the real npm.cmd, located by PATH lookup rather than a
REM hardcoded install path, so it survives a Node reinstall or relocation.
REM
REM It lives in the repository and is put on PATH by scripts/android-build.ps1
REM for the build process only. Nothing is installed into Node's directory, so
REM the machine's Node installation is left exactly as the installer made it.
REM
REM Guard: resolve npm.cmd BEFORE this directory is prepended to PATH, and never
REM resolve anything named npm*.bat, so the shim cannot call itself.
REM ---------------------------------------------------------------------------

setlocal
set "NPM_CMD="
for /f "delims=" %%i in ('where npm.cmd 2^>nul') do (
    if not defined NPM_CMD set "NPM_CMD=%%i"
)
if not defined NPM_CMD (
    echo npm.bat shim: could not find npm.cmd on PATH 1>&2
    exit /b 1
)
call "%NPM_CMD%" %*
exit /b %ERRORLEVEL%