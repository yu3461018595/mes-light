@echo off
chcp 65001 >nul
title 智工生产管理系统
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel%==0 (set "NODE=node") else (set "NODE=C:\Users\Admin\.workbuddy\binaries\node\versions\22.22.2\node.exe")

echo.
echo   正在启动智工生产管理系统...
echo   浏览器将自动打开 http://localhost:5173
echo   关闭此窗口即可停止服务
echo.

start "" http://localhost:5173
"%NODE%" server.js
pause
