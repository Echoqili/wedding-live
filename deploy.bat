@echo off
chcp 65001 >nul
title Wedding Live Server
setlocal enabledelayedexpansion

echo.
echo  ============================================
echo    婚礼互动服务 - 一键启动（Windows 现场版）
echo  ============================================
echo.

REM ---------- 1. 检查 Node.js ----------
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo  [错误] 未找到 Node.js，请先安装：https://nodejs.org/
  echo  安装后重新双击本脚本即可。
  pause
  exit /b 1
)

REM ---------- 2. 安装依赖（首次） ----------
if not exist node_modules\ws (
  echo  [1/4] 正在安装依赖，请稍候...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo  [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
) else (
  echo  [1/4] 依赖已就绪
)

REM ---------- 3. 启动服务 ----------
echo  [2/4] 启动服务...
start "WeddingLiveServer" /min node server.js

REM ---------- 4. 获取局域网 IP ----------
echo  [3/4] 正在获取局域网地址...
set "IP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
  if not defined IP set "IP=%%a"
)
set "IP=%IP: =%"

echo  [4/4] 启动完成！
echo.
echo  ============================================
echo   * 大屏地址     http://localhost:8080/screen.html
if defined IP (
  echo   * 宾客扫码     http://%IP%:8080/
  echo   * 主持控台     http://%IP%:8080/host.html?ws=ws://%IP%:8080
  echo   * 本机 IP      %IP%
)
echo   * 数据目录     data\  （重启不丢，请勿删除）
echo   * 服务窗口已最小化，关闭它即停止服务
echo  ============================================
echo.
start http://localhost:8080/
echo  已自动打开浏览器。婚礼当天请把此窗口最小化，不要关闭。
echo.
pause
