@echo off
title Dibbo Store
cd /d "%~dp0"
echo.
echo   Opening Dibbo Store...
echo   Shop:    http://127.0.0.1:5000
echo   Owner:   owner@dibbostore.com  /  dibbo1234
echo   (keep this window open, close it to stop the shop)
echo.
start "" http://127.0.0.1:5000
python app.py
pause
