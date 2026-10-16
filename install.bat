@echo off
chcp 65001 >nul
REM WorkBuddy Proxy 自动安装脚本 (Windows)
REM 安装到 %USERPROFILE%\.config\workbuddyaip\

setlocal enabledelayedexpansion

set "CONFIG_DIR=%USERPROFILE%\.config\workbuddyaip"
set "API_DIR=%CONFIG_DIR%\API"
set "LOG_DIR=%CONFIG_DIR%\logs"
set "APP_DIR=%CONFIG_DIR%\app"
set "SCRIPT_DIR=%~dp0"

echo ==========================================
echo   WorkBuddy Proxy 安装脚本 (Windows)
echo ==========================================

REM 创建目录
echo ==> 创建配置目录...
if not exist "%API_DIR%" mkdir "%API_DIR%"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

REM 复制项目文件
echo ==> 安装程序文件...
if exist "%APP_DIR%" rmdir /s /q "%APP_DIR%"
xcopy /e /i /q "%SCRIPT_DIR%." "%APP_DIR%" >nul
if exist "%APP_DIR%\node_modules" rmdir /s /q "%APP_DIR%\node_modules"

REM 安装依赖
echo ==> 安装 Node.js 依赖...
cd /d "%APP_DIR%"
where npm >nul 2>&1
if errorlevel 1 (
  echo 错误: 未找到 npm，请先安装 Node.js
  pause
  exit /b 1
)
call npm install --production 2>&1 | findstr /v "npm notice"

REM 创建启动批处理
echo ==> 创建启动命令...
(
echo @echo off
echo cd /d "%APP_DIR%"
echo node src/server.js %%*
) > "%CONFIG_DIR%\workbuddy-proxy.bat"

(
echo @echo off
echo taskkill /f /im node.exe /fi "windowtitle eq WorkBuddy*" 2^>nul
echo taskkill /f /im node.exe 2^>nul
echo 已停止
) > "%CONFIG_DIR%\workbuddy-proxy-stop.bat"

(
echo @echo off
echo tasklist /fi "imagename eq node.exe" 2^>nul | find "node.exe" ^>nul
echo if errorlevel 1 ^(echo 未运行^) else ^(echo 运行中^& curl -s http://127.0.0.1:8788/health^)
) > "%CONFIG_DIR%\workbuddy-proxy-status.bat"

REM 添加到 PATH
echo ==> 注册到用户 PATH...
setx PATH "%PATH%;%CONFIG_DIR%" >nul 2>&1

echo.
echo ==========================================
echo   安装完成！
echo ==========================================
echo.
echo   配置目录: %CONFIG_DIR%
echo   账号目录: %API_DIR% (放入 .json 账号文件自动导入)
echo   日志目录: %LOG_DIR%
echo.
echo   命令 (新开终端生效):
echo     启动:  workbuddy-proxy
echo     停止:  workbuddy-proxy-stop
echo     状态:  workbuddy-proxy-status
echo.
echo   管理页: http://127.0.0.1:8788/
echo   API:    http://127.0.0.1:8788/v1
echo.
echo   提示: 将账号 JSON 文件放到 %API_DIR% 后重启即可自动导入
echo ==========================================
echo.

set /p "START=立即启动代理？[Y/n] "
if /i "%START%"=="y" (
  echo ==> 启动代理...
  call "%CONFIG_DIR%\workbuddy-proxy.bat"
) else if "%START%"=="" (
  echo ==> 启动代理...
  call "%CONFIG_DIR%\workbuddy-proxy.bat"
)

endlocal
