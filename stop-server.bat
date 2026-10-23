@echo off
rem Stops the Cricket Lab server. Your data is kept for next time.
cd /d "%~dp0"
docker compose down
pause
