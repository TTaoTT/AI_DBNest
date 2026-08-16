@echo off
rem 一键启动 DB Admin 预览服务器 (Windows 双击运行)
rem 启动后浏览器打开 http://localhost:5180/
cd /d %~dp0
set NODE_PATH=C:\Users\Darker\.dbadmin-deps\node_modules
set PREVIEW_PORT=5180
echo Starting DB Admin preview -^> http://localhost:5180/
"C:\Users\Darker\.workbuddy\binaries\node\versions\22.22.2\node.exe" server\preview-server.cjs
pause
