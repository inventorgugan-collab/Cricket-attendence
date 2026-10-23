@echo off
rem Starts the Cricket Lab server on this computer for a trial.
rem Needs Docker Desktop installed and running.
cd /d "%~dp0"

docker info >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop is not running. Open Docker Desktop, wait until it says "Engine running", then try again.
  pause
  exit /b 1
)

rem Secret keys for this computer, made once.
if not exist .env (
  powershell -NoProfile -Command "$k = { -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) }) }; \"JWT_SECRET=$(& $k)`nMESSAGING_KEY=$(& $k)\" | Set-Content -Encoding ascii .env"
)

echo Starting the server. The first time takes a few minutes...
docker compose up -d --build
if errorlevel 1 (
  echo The server did not start. Send the messages above to Claude.
  pause
  exit /b 1
)

echo Waiting for the server to be ready...
:wait
curl -s http://localhost:3000/health >nul 2>&1
if errorlevel 1 (
  timeout /t 3 /nobreak >nul
  goto wait
)

rem The academy and its admin login, the first time only.
if not exist .academy-created (
  echo.
  echo Create your academy. Everyone types its code when they sign in.
  set /p CODE="Academy code (short, lowercase, e.g. gca): "
  set /p NAME="Academy name (e.g. Gugan Cricket Academy): "
  set /p ADMIN="Admin login (e.g. admin): "
  set /p PASS="Admin password (at least 8 characters): "
  call :create
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

echo.
echo ============================================================
echo  The server is running.
echo  On the phone, tap "Server" on the sign-in screen and enter
echo  this computer's address (the phone must use the same Wi-Fi):
echo.
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo     %%a
echo ============================================================
echo  To stop it later, run stop-server.bat.
pause
exit /b 0

:create
docker compose exec -T api npm run -s academy:create -- "%CODE%" "%NAME%" "%ADMIN%" "%PASS%"
if errorlevel 1 (
  echo Could not create the academy. Check the details and run start-server.bat again.
  exit /b 1
)
echo done> .academy-created
exit /b 0
