@echo off
title HyperDrain - 32GB High-Speed Resilient Downloader
echo =========================================================
echo   HyperDrain - 32GB High-Speed Resilient Downloader
echo =========================================================
cd /d "%~dp0"

REM 1. Start backend engine in background
start /b "" hyperdrain.exe --no-window

REM 2. Wait 1 second for engine to initialize
timeout /t 1 /nobreak >nul

REM 3. Launch Desktop App window
if exist "node_modules\.bin\electron.cmd" (
    call "node_modules\.bin\electron.cmd" --no-sandbox .
) else (
    start msedge --app=http://127.0.0.1:6880 || start chrome --app=http://127.0.0.1:6880 || start http://127.0.0.1:6880
)
