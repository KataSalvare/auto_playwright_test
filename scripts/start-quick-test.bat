@echo off
setlocal

rem Windows 终端入口：启动、重启或停止快速测试页面服务。
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js。
  exit /b 1
)

node scripts\quick-test-server.mjs %*
