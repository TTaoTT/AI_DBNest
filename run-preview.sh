#!/usr/bin/env bash
# 一键启动 DB Admin 预览服务器（连接真实 PG/SQLite/MySQL）
# 用法: bash run-preview.sh  或 双击 run-preview.bat
#
# 说明:
#  - preview-server.cjs 是零依赖服务器, 直接 node 运行即可
#  - MySQL 族(mysql/mariadb/tidb/oceanbase)依赖 mysql2, 已预装在 C:\Users\Darker\.dbadmin-deps
#  - T 盘子进程只读, 故 node_modules 放 C 盘 + NODE_PATH 指向
#  - 启动后浏览器打开 http://localhost:5180/
set -e
cd "$(dirname "$0")"
export NODE_PATH="C:/Users/Darker/.dbadmin-deps/node_modules"
export PREVIEW_PORT="${PREVIEW_PORT:-5180}"
echo "▶ 启动 DB Admin 预览 → http://localhost:${PREVIEW_PORT}/"
echo "  (MySQL 族需 mysql2: $([ -d "$NODE_PATH/mysql2" ] && echo 已就绪 || echo 缺失,请先 npm install -g mysql2 或装到 .dbadmin-deps))"
"C:/Users/Darker/.workbuddy/binaries/node/versions/22.22.2/node.exe" server/preview-server.cjs
