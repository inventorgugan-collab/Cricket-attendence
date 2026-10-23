@echo off
rem Lets phones on the same Wi-Fi reach the Cricket Lab server (port 3000)
rem through Windows Firewall. Asks for administrator permission once.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
netsh advfirewall firewall delete rule name="Cricket Lab server" >nul 2>&1
netsh advfirewall firewall add rule name="Cricket Lab server" dir=in action=allow protocol=TCP localport=3000 profile=any
if errorlevel 1 (
  echo Could not change the firewall. Take a screenshot and send it to Claude.
) else (
  echo Done. Phones on the same Wi-Fi can now reach the server.
)
pause
