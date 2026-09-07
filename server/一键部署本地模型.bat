@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo Image To Slice - 一键部署本地模型
echo -----------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先运行“一键部署环境.bat”。
  pause
  exit /b 1
)

call npm run local-models:setup
if errorlevel 1 (
  echo.
  echo 本地模型部署失败，请检查上方错误信息。
  pause
  exit /b 1
)

echo.
echo 本地模型已准备好。
pause
