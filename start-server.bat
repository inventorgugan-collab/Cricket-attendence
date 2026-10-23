@echo off
rem Starts the Cricket Lab server on this computer for a trial.
rem Needs Docker Desktop installed and running.
cd /d "%~dp0"

if not exist docker-compose.yml (
  echo Can't find docker-compose.yml next to this file.
  echo Extract the whole zip first, then run start-server.bat from the extracted folder.
  pause
  exit /b 1
)

echo [1/4] Checking Docker...
docker info >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop is not running. Open Docker Desktop, wait until it says "Engine running", then try again.
  pause
  exit /b 1
)

rem Secret keys for this computer, made once.
if not exist .env call :makekeys

echo [2/4] Starting the server. The first time downloads about 500 MB and takes a few minutes...
docker compose up -d --build
if errorlevel 1 (
  echo.
  echo The server did not start. Take a screenshot of this window and send it to Claude.
  pause
  exit /b 1
)

echo [3/4] Waiting for the server to be ready...
set TRIES=0
:wait
curl -s http://localhost:3000/health >nul 2>&1
if not errorlevel 1 goto ready
set /a TRIES+=1
if %TRIES% geq 60 (
  echo The server did not answer. Take a screenshot of this window and send it to Claude.
  docker compose logs --tail 30 api
  pause
  exit /b 1
)
timeout /t 3 /nobreak >nul
goto wait

:ready
if exist .academy-created goto done
echo.
echo [4/4] Create your academy. Everyone types its code when they sign in.
set /p CODE="Academy code (short, lowercase, e.g. gca): "
set /p NAME="Academy name (e.g. Gugan Cricket Academy): "
set /p ADMIN="Admin login (e.g. admin): "
set /p PASS="Admin password (at least 8 characters): "
docker compose exec -T api npm run -s academy:create -- "%CODE%" "%NAME%" "%ADMIN%" "%PASS%"
if errorlevel 1 (
  echo Could not create the academy. Check the details and run start-server.bat again.
  pause
  exit /b 1
)
echo done> .academy-created

:done
echo.
echo ============================================================
echo  The server is running.
echo  On the phone, tap "Server" on the sign-in screen and enter
echo  this computer's address (the phone must use the same Wi-Fi):
echo.
rem Only the adapter with a router (Wi-Fi or cable); virtual ones have none.
set FOUND=
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "(Get-NetIPConfiguration | Where-Object IPv4DefaultGateway).IPv4Address.IPAddress" 2^>nul`) do (
  echo     %%a
  set FOUND=1
)
if not defined FOUND for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo     %%a
echo.
echo  For test logins, run add-demo-academy.bat.
echo  To stop the server later, run stop-server.bat.
echo ============================================================
pause
exit /b 0

:makekeys
setlocal enabledelayedexpansion
set A=local-trial-
set B=local-trial-
for /l %%i in (1,1,10) do (
  set A=!A!!RANDOM!
  set B=!B!!RANDOM!
)
> .env echo JWT_SECRET=!A!
>> .env echo MESSAGING_KEY=!B!
endlocal
exit /b 0
