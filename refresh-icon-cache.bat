@echo off
chcp 65001 >nul
rem ============================================================
rem  DBNest 任务栏/桌面图标缓存刷新(安装新版 logo 后图标不刷新)
rem  原理: 终止 explorer → 删 IconCache.db → 重新启动 explorer
rem  使用: 右键管理员运行(或普通双双击亦可,杀 explorer 需要权限会自提)
rem ============================================================
echo [1/4] 关闭 DBNest 与 explorer(释放图标锁)...
taskkill /im db-admin.exe /f >nul 2>&1
taskkill /im explorer.exe /f >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/4] 删除系统图标缓存...
del /f /q "%LocalAppData%\IconCache.db" >nul 2>&1
del /f /q "%LocalAppData%\Microsoft\Windows\Explorer\iconcache_*.db" >nul 2>&1
echo       已清理

echo [3/4] 重新启动 explorer...
start explorer.exe

echo [4/4] 完成! 任务栏/桌面应为新图标, 若仍为旧请重启电脑
echo.
pause