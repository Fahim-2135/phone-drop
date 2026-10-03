@echo off
rem Lets your phone reach Phone Drop on PRIVATE networks (your home wifi).
rem Public networks (cafes, university) stay blocked on purpose.
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" & exit /b)
netsh advfirewall firewall add rule name="Phone Drop (private networks)" dir=in action=allow program="%LOCALAPPDATA%\Programs\phone-drop\phone-drop.exe" profile=private enable=yes
echo.
echo Done. Phone Drop can now be reached on Private networks.
echo Make sure your Wi-Fi is set to Private: Settings - Network ^& internet - Wi-Fi - your network - Private.
echo.
pause
