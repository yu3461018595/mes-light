@echo off
chcp 65001 >nul
title 智工生产管理系统
cd /d "%~dp0"

set "NODE="
where node >nul 2>nul && set "NODE=node"

if not defined NODE (
  if exist "%USERPROFILE%\.workbuddy\binaries\node\versions" (
    for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
      if exist "%%d\node.exe" if not defined NODE set "NODE=%%d\node.exe"
    )
  )
)

if not defined NODE (
  echo.
  echo   未检测到 Node.js，请先安装 Node 22 或更高版本：https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动智工生产管理系统...
echo   浏览器将自动打开 http://localhost:5173
echo   关闭此窗口即可停止服务
echo.

start "" http://localhost:5173
"%NODE%" server.js
pause
