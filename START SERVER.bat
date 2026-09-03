@echo off
title Portfolio Dashboard - Preview
cd /d "%~dp0"
echo.
echo   Starting the dashboard preview...
echo   When it says "Dashboard preview", open:  http://localhost:3200
echo.
echo   (This is the UI with demo data. To run the real APIs, use "npx vercel dev".)
echo.
node serve.mjs
pause
