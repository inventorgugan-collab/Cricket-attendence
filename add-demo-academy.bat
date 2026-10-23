@echo off
rem Adds a demo academy (code "demo") with test logins and sample data, for
rem trying the app. Run start-server.bat first. Your own academy is not touched.
cd /d "%~dp0"

curl -s http://localhost:3000/health >nul 2>&1
if errorlevel 1 (
  echo The server is not running. Run start-server.bat first.
  pause
  exit /b 1
)
if exist .demo-created (
  echo The demo academy is already there.
  goto show
)

docker compose exec -T -e NODE_ENV=development -e SEED_ACADEMY=demo -e "SEED_ACADEMY_NAME=Demo Cricket Academy" -e SEED_PASSWORD=demo1234 api npx tsx src/seed.ts
if errorlevel 1 (
  echo Could not add the demo academy. Send the messages above to Claude.
  pause
  exit /b 1
)
echo done> .demo-created

:show
echo.
echo ============================================================
echo  Demo academy code: demo        Password for all: demo1234
echo.
echo    admin     the academy admin
echo    arun      coach
echo    bala      coach
echo    ravi      player
echo    karthik   player
echo    lakshmi   parent of Ravi and Priya
echo ============================================================
pause
