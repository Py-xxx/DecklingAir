@echo off
:: VM Control Bridge — Windows startup script
:: Place a shortcut to this file in:
:: C:\Users\<YourName>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup

set "BRIDGE_DIR=%~dp0"
cd /d "%BRIDGE_DIR%"

:: Edit config.json with the correct Pi IP before running!
:: Then run this file or place a shortcut in Startup folder.

start "" /min pythonw bridge.py
