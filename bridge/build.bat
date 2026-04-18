@echo off
echo Building VM Control Bridge...
pip install pyinstaller
pyinstaller --onefile --windowed --name "VMControlBridge" --icon NONE bridge.py
echo.
echo Done! The .exe is in the dist\ folder.
pause
