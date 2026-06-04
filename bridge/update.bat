@echo off
echo VM Control Bridge — Update
echo ===========================
echo.

:: Move to the repo root (two levels up from bridge\)
cd /d "%~dp0.."

echo Pulling latest changes from git...
git pull
if %ERRORLEVEL% neq 0 (
    echo.
    echo ERROR: git pull failed. Check your internet connection or repo status.
    pause
    exit /b 1
)

echo.
echo Installing/updating Python dependencies...
cd bridge
pip install -r requirements.txt
if %ERRORLEVEL% neq 0 (
    echo.
    echo WARNING: pip install had errors. Check requirements.txt.
)

echo.
echo Update complete!
echo.
echo Tip: restart the bridge (right-click tray icon ^> Quit, then run startup.bat)
echo.
pause
