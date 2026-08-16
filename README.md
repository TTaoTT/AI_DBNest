# DBNest · 库巢

> 开源数据库管理工具 · 对标 Navicat 的一站式方案 · 桌面零端口 + Web 双形态

**DBNest(库巢)** 是一款面向开发者的数据库管理客户端：连接、浏览、编辑、查询、设计、同步、传输、导出，覆盖日常数据库工作的完整链路。多库多连接并存，深色界面，桌面客户端与 Web 服务双形态可选。

---

## ✨ 核心功能

### 🔌 连接管理
- **10+ 数据库类型**：MySQL / MariaDB / TiDB / OceanBase / PostgreSQL / openGauss / SQLite(零依赖) / Oracle / SQL Server / MongoDB(驱动待装)
- 连接向导动态表单 + 默认端口 + 一键测试连接
- 连接持久化(本地加密保存)、**密码保险库**(Web Crypto AES-256-GCM + PBKDF2 120k)
- **懒连接**(Navicat 式：未连接占位虚线节点，双击原地连接)
- **刷新页面自动恢复连接**，关闭软件/浏览器才断开
- 多连接并列 + 快速切换

### 🌳 对象导航
- 连接 → 库 → 模式 → 表/视图/函数/序列 完整对象树
- PG 多库浏览(其他库点击懒加载)
- 统一 SVG 图标(表/视图/函数/序列彩色徽章)
- 对象筛选框 + 右键分级菜单(连接/库/表/视图/函数/序列/行/单元格/页签)
- 新建数据库 / 新建模式(右键即建)

### 📊 数据网格
- 内联编辑(Enter/Esc/Tab 跳格)、脏标记、批量提交
- **多条件筛选构建器**(字段 + 运算符 + 值，AND/OR 逻辑)、distinct 值快捷选择、已应用筛选 chips
- 排序三态、分页(1000 行保护 + 加载更多)、外键跳转
- **撤销 Ctrl+Z / 重做 Ctrl+Y**
- 多选行 + 批量删除、全选、新增行自动滚底
- 列宽拖拽、列拖拽调序、网格 Ctrl+F 查找高亮
- 大文本/二进制查看、NULL 快捷设置、PII 脱敏展示

### 📝 SQL 编辑器
- CodeMirror 5 本地化(零 CDN，离线可用)，语法高亮 + 行号
- **智能补全**(关键字/表/列/函数 + 类型徽章，三层兜底)
- 多语句执行 → 每条结果独立子 Tab；多结果集
- 执行计划(树 + 文本)、格式化、历史回填
- 连接/库/Schema 三级切换下拉
- **运行 SQL 文件**(恢复向导：智能分句，支持 `$$` 函数体/注释/引号)
- 拖表名到编辑器生成 SQL

### 🛠 表设计器
- 字段页(类型/默认值/主键/非空/注释)
- 索引页(名称/唯一/btree/hash/gin/gist/多列)
- 外键页(引用表/列/ON DELETE/UPDATE)
- DDL 预览 + 增量落库(新表 CREATE / 现有表 ALTER)，Ctrl+S 保存

### 🔄 同步与传输
- **跨库传输向导**(Navicat 式：源/目标连接 + 库 + 表多选 + 模式选择 + 实时进度日志)
- **跨方言类型映射**(PG ↔ MySQL ↔ SQLite 三向，含长度解析/默认值清理)
- 结构同步(diff → ALTER 脚本 → 预览执行)
- 数据同步(主键级比对 → INSERT/UPDATE/DELETE 合并脚本)

### 📦 导入 / 导出
- 导出 CSV / **Excel(.xls SpreadsheetML)** / JSON(按钮选格式)
- 导出/转储 SQL 向导(仅结构 / 仅数据 / 结构和数据，整库合并)
- 导入 CSV(自动建表 + 类型推断)
- 备份恢复(运行 SQL 文件)

### 📈 监控与权限
- 服务器监控(会话 + 库统计 + 每会话 Kill)
- 用户/角色查看(PG)、审计日志(内存环形)
- 错误提示建议化(认证/连接/语法/超时/权限等自动附修复建议)

### 🎨 体验
- 深色主题、统一 SVG 图标、快捷键体系(F5/Ctrl+F5/Ctrl+E/Ctrl+F/Ctrl+S/Ctrl+R/Ctrl+G/Ctrl+Z/Y)
- 断线自动重连、加载进度条、空状态引导
- 自定义弹窗(新建库/模式/导出格式/筛选构建器等)

---

## 🏗 架构(桌面零端口 + Web 双形态)

```
┌─ 桌面版(Electron, 零 HTTP 端口)─────────────┐
│ 主进程: ipcMain.handle('api') → handleApi() │
│ preload: contextBridge 白名单 → dbAdminBridge│
│ 窗口: loadFile(index.html) — 纯本地文件      │
└─────────────────────────────────────────────┘
┌─ Web 版(Node, 独立部署)─────────────────────┐
│ server/preview-server.cjs(HTTP + 静态资源)   │
│ LISTEN_HOST=0.0.0.0 局域网可访问             │
└─────────────────────────────────────────────┘
        └── 共用：server 动作层 handleApi(26 API)
```

- **统一动作层**：`handleApi(path, body)` 一套业务代码，HTTP 与 IPC 双通道复用，错误分类一致(404 连接失效 / 400 SQL 错误 / 500 其他)
- **桌面版零端口**：不监听任何 TCP 端口，断网可全功能使用，更安全
- **前端 api() 双通道**：`window.dbAdminBridge ? IPC : fetch`，Web 版零改动
- **零 CDN 依赖**：CodeMirror / 图标 / 字体全部本地化，离线可用

---

## 🚀 快速开始

### 方式一：桌面安装包(推荐)
下载 `DBNest-Setup-1.0.0.exe` → 双击安装 → 桌面快捷方式启动。
- 零 HTTP 端口、断网可用、配置存 `%APPDATA%\db-admin\db-admin.json`

### 方式二：Web 版(局域网/服务器部署)
```bash
cd dbnest-web-dist
npm install          # 首次(安装 mysql2)
npm start            # http://localhost:5180/
# 局域网访问:
LISTEN_HOST=0.0.0.0 node server/preview-server.cjs
```

### 方式三：源码运行(开发)
```bash
# Web 预览模式
bash run-preview.sh   # 或 run-preview.bat → http://localhost:5180/
```

---

## 🧰 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 原生 HTML/JS 单页(index.html 内联业务脚本) + CodeMirror 5(本地) |
| 服务端 | Node.js(pgwire 纯 JS 协议驱动 / node:sqlite / mysql2) |
| 桌面 | Electron 35 + preload(contextBridge) + IPC |
| 安全 | Web Crypto AES-256-GCM 密码保险库 + PBKDF2(120k) |
| 打包 | Inno Setup 6(安装程序) / 自建 Web 分发脚本 |

---

## 📁 目录结构

```
├── server/                  # 服务端
│   ├── preview-server.cjs   # HTTP 服务器 + handleApi 统一动作层(26 API)
│   └── src/                 # PG/SQLite 协议驱动、连接预设、保险库
├── web/
│   ├── preview/             # 前端单页(index.html + vendor/codemirror)
│   └── src/lib/             # 前后端共用逻辑(db-logic / ui-interactions)
├── doc/                     # 分析文档(进度矩阵/技术方案/比对清单)
├── build-web-dist.cjs       # Web 版独立打包脚本
├── push-to-github.bat       # 一键推送 GitHub(本地执行)
└── run-preview.sh / .bat    # 一键启动 Web 预览
```

---

## 📚 文档索引

| 文档 | 内容 |
|---|---|
| [doc/对标Navicat-进度矩阵.md](doc/对标Navicat-进度矩阵.md) | 141 项功能对标进度、完成度、剩余 P1/P2 |
| [doc/桌面Web分离打包-技术方案.md](doc/桌面Web分离打包-技术方案.md) | 零端口 IPC 架构改造方案与实施记录 |
| [doc/数据库管理应用-技术方案.md](doc/数据库管理应用-技术方案.md) | 整体技术选型与设计 |
| [doc/Navicat比对清单-细化.md](doc/Navicat比对清单-细化.md) | 功能比对细化清单 |
| [doc/Navicat操作-易用-UI交互-细化对比.md](doc/Navicat操作-易用-UI交互-细化对比.md) | 操作/易用/UI 交互对比 |

---

## 🧩 待规划 / 已知限制

- Oracle / SQL Server / MongoDB 驱动待实装(Stub 已注册)
- SSH 隧道、SSL/TLS 连接 UI
- Excel 导入、查询构建器、执行计划图形化
- 撤销/重做暂限于数据网格编辑
- 多语言(当前仅中文)

详细进度见 [doc/对标Navicat-进度矩阵.md](doc/对标Navicat-进度矩阵.md)。

---

## ⚖️ 许可与声明

- 本项目为个人开发学习项目，仅供学习与内部使用
- 连接凭据仅存本机(加密)，请妥善保管主密码
- 与 Navicat 等商业产品无任何关联，功能对标仅供自研参考

---

*DBNest · 库巢 —— 让数据库触手可及*
