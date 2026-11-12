@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动家庭物资清点表……（关闭此窗口即停止服务）
node --no-warnings server.js
pause
