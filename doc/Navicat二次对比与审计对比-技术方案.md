# Navicat 二次对比 · 历史操作审计 · 数据库对比 · 技术方案

> 版本：v1.0 · 2026-08-17
> 状态：技术方案（未实现，待确认后实施）
> 对标准确性：Navicat 17.3（Premium）官方功能列表 + 现有 `doc/对标Navicat-进度矩阵.md`(v0.6.2, 141 项, 68%)

---

## 一、Navicat 17 操作二次对比（聚焦 v0.6.2 矩阵未覆盖的 Navicat 17 新增项）

现有矩阵已覆盖 141 项(✅90/🟡12/❌39)。本轮对照 **Navicat 17.3 功能列表** 补漏，新增 **24 项** 操作级对比：

| # | Navicat 17 功能 | Navicat 说明 | DBNest 现状 | 差距 | 建议优先级 |
|---|---|---|---|---|---|
| 1 | **AI 助手**（ChatGPT/Deepseek/Gemini/Ollama/Claude/通义） | 附加数据库结构、多模型对比、解释/优化/美化/转换 SQL、修复错误 | ❌ 无 | 可自建(接 LLM API + 注入 schema 结构) | P1 |
| 2 | **数据字典**（Data Dictionary） | 自动生成库/表/字段说明文档(Word/PDF/HTML) | ❌ 无 | 基于 information_schema 生成 Markdown/HTML | P2 |
| 3 | **表配置文件**（Table Profile） | 表内数据画像:字段统计/分布/唯一性/空值率 | ❌ 无 | 数据页加「画像」子 Tab:COUNT/SUM/AVG/MIN/MAX + 分布 SQL | P1 |
| 4 | **跨数据库复制粘贴数据** | 从 A 库复制行 → 直接粘贴到 B 库 | ❌ 无 | 剪贴板 JSON 中间态 + 目标表类型映射(复用 mapType) | P1 |
| 5 | **固定查询结果**（Pinned Result） | 执行计划/查询结果可固定对比 | ❌ 无 | 结果 Tab 加「📌 固定」并存快照列表 | P2 |
| 6 | **查询构建器**（Query Builder） | 可视化拖拽表/列/条件生成 SQL | ❌ 无(有筛选构建器) | 表节点拖拽已支持 → 扩展为多表 JOIN 面板 | P1 |
| 7 | **可视化执行计划**（Visual Explain） | 图形化执行计划节点树 | 🟡 文本+树 | 渲染 Canvas/SVG 节点图(计划数据已有) | P1 |
| 8 | **代码片段**（Snippet） | 可复用 SQL 片段库 | ❌ 无 | 编辑器侧栏片段列表 + 插入 | P2 |
| 9 | **虚拟组**（Virtual Group） | 连接/查询/模型分组管理 | ❌ 无 | 树加分组目录(纯前端) | P2 |
| 10 | **数据库范围搜索**（DB Scope Search） | 全库对象/字段名搜索 | ❌ 无(有对象筛选) | 扩展为跨库 information_schema 模糊搜 | P2 |
| 11 | **连接配置文件/连接颜色** | 连接级配置模板 + 颜色标签 | ❌ 无 | 连接弹窗加颜色选择 + 树着色 | P2 |
| 12 | **Kerberos 认证** | 企业级认证 | ❌ 无 | 驱动层支持(低优先) | P3 |
| 13 | **命令列界面**（Command-line） | 内嵌 psql-like 终端 | ❌ 无 | SQL 页加「命令行」模式(逐条执行+历史) | P2 |
| 14 | **数据生成器**（Data Generator） | 按业务规则生成测试数据 | ❌ 无 | 表右键「生成测试数据」:字段类型 → 随机值模板 | P1 |
| 15 | **数据字典导出** | 文档化 | ❌ 无 | 同 #2 | P2 |
| 16 | **表单视图**（Form View） | 单条记录表单化编辑 | ❌ 无(网格有) | 数据页「表单视图」:字段标签+输入框+上/下条 | P2 |
| 17 | **文本/Hex/图像/网页查看器** | 大字段多形态查看 | ❌ 无(文本有) | bytea→Hex/图像预览;text→网页渲染 | P1 |
| 18 | **外键数据选择器**（FK Data Selector） | 外键列下拉选择引用表数据 | ❌ 无(有跳转) | 编辑外键列时下拉加载引用表 | P2 |
| 19 | **参数查询**（Parameter Query） | 查询中 `:param` 运行时弹输入 | ❌ 无 | 执行前解析 `:name` → 输入弹窗 | P2 |
| 20 | **SQL 简化**（Simplify） | 反向格式化/压缩 | ❌ 无 | 格式化工具加「压缩」模式 | P2 |
| 21 | **备份文件转 SQL 脚本** | 恢复备份为可读 SQL | ❌ 无 | 安装包产物链路(后续) | P3 |
| 22 | **聚焦模式**（Focus Mode） | 隐藏侧栏沉浸式编辑 | ❌ 无 | 顶栏加「沉浸」开关(隐藏树/侧栏) | P2 |
| 23 | **自动运行**（Automation） | 计划任务:查询/备份/同步/生成/导出 | ❌ 无 | 后端 cron 任务表 + 前端任务面板 | P2 |
| 24 | **BI 仪表盘/模型工作区**（企业版） | 图表联动/ER 建模 | ❌ 无 | 远期(依赖大) | P3 |

**二次对比结论**：与 Navicat 17 的剩余差距集中于 **增值/生产力层**（AI 助手、数据画像、生成器、查询构建器、可视化计划），而非核心操作。核心链路（连接/浏览/编辑/查询/同步/导出）已对齐 94%。

---

## 二、历史操作审计（跨客户端：其他工具连库的操作也能查到）

### 2.1 需求本质

> 现在审计日志只能看到**本工具**发起的操作。用户需要看到**所有客户端**（Navicat / psql / 业务程序 / 其他 DBA 工具）对该库执行过的操作。

**关键认知**：客户端工具本身**无法**记录其他客户端的操作——只能通过**数据库服务器端**的审计能力查询。因此方案 = 读取服务器已有的审计/统计设施，统一展示。

### 2.2 PostgreSQL 方案（推荐，零改动服务器配置即可起步）

| 数据源 | 覆盖范围 | 关键字段 | 权限 |
|---|---|---|---|
| **`pg_stat_statements`** | 所有客户端执行过的 SQL 聚合统计（queryid 去重） | query / calls / total_exec_time / rows / userid / dbid / last_* | 需扩展已装(shared_preload_libraries)；查询需 pg_read_all_stats |
| **`pg_stat_activity`** | 当前所有连接（含其他客户端） | usename / client_addr / application_name / state / query / backend_start | pg_read_all_stats |
| **`pg_stat_database` / `pg_stat_user_tables`** | 库/表级访问统计 | xact_commit/rollback / seq_scan / idx_scan / n_tup_ins/upd/del / last_analyze | 默认可读 |
| **`log_statement=all` 服务器日志** | 完整语句级审计（含历史） | 需服务端开启 + 解析 CSV 日志 | 文件系统/DBA |
| **`pg_audit` 扩展** | 企业级 DDL/DML 审计 | 每语句 + 角色 + 对象 | 需安装扩展 |
| **事件触发器** | 捕获 DDL（谁/何时/改了什么） | 自建 evt_trigger + 审计表 | 需 superuser 建 |

**推荐落地组合（P0）**：
```
/api/audit/history  →  PG:
  SELECT q.query, q.calls, q.total_exec_time, q.rows,
         pg_get_userbyid(q.userid) AS usr,
         pg_get_userbyid(q.dbid) AS db, q.last_exec_time
  FROM pg_stat_statements q
  ORDER BY q.last_exec_time DESC  [LIMIT N]
  + WHERE 过滤: 库/用户/时间/关键字

  SELECT a.usename, a.client_addr, a.application_name,
         a.state, a.query, a.backend_start
  FROM pg_stat_activity a
```
- `application_name` 可区分客户端（Navicat 连接会带 app 名，psql 默认 psql，JDBC 带驱动名）→ 满足"知道是谁连的"
- `pg_stat_statements` 记录**所有客户端**的 SQL（含 Navicat 执行的）→ 满足"跨工具可查"
- 时间维度：last_exec_time 最近执行；历史深度受服务器保留策略限制（pg_stat_statements 是聚合快照，非完整流水）

**增强（P1）**：服务器开启 `log_statement = 'ddl'` 或 `'all'` + `log_line_prefix`，新增 `/api/audit/log` 读取 PG 日志目录 CSV 文件解析（按时间/角色/IP 过滤）→ 完整操作流水。

### 2.3 MySQL 方案

| 数据源 | 覆盖 | 关键点 |
|---|---|---|
| **`performance_schema.events_statements_history`** | 最近语句（含其他客户端，进程内缓冲） | 需 performance_schema 开启；默认 history 每线程 10 条 → 建议查 `events_statements_history_long` |
| **`general_log`**（log_output=TABLE） | 全量语句流水 | 需服务端开启（有性能开销）；查 `mysql.general_log` |
| **`information_schema.processlist` / `sys.processlist`** | 当前连接 | id/user/host/db/command/info |
| **`slow_query_log`** | 慢查询（含其他客户端） | 需开启 + long_query_time |
| **`binlog`**（变更审计） | 所有 DML 变更 | 需 binlog_format=ROW + 解析（工具侧较重，P2） |
| **Audit Log 插件**（企业版） | 完整审计 | 需插件 |

**推荐落地**：
```
/api/audit/history → MySQL:
  SELECT sql_text, rows_affected, timer_wait,  -- 语句级
         processlist_id, thread_id
  FROM performance_schema.events_statements_history_long
  ORDER BY event_id DESC [LIMIT N]
  + processlist: SELECT id, user, host, db, command, info FROM information_schema.processlist
```

### 2.4 SQLite

- 无服务器审计 → 仅能查本工具操作（现有 AUDIT 内存日志）+ PRAGMA 层面的表访问统计不可得 → **标注「SQLite 不支持跨客户端审计」**。

### 2.5 前端 UI 设计（新增「历史操作」面板）

```
监控页新增 Tab「历史操作」
├─ 数据源切换: 语句统计(pg_stat_statements) / 当前连接(activity) / 服务器日志(可选)
├─ 过滤条: 库▾ | 用户▾ | 客户端/IP输入 | 时间范围 | 关键字
├─ 表格列: 时间 | 用户 | 客户端(application_name/host) | 库 | SQL(截断+悬停全显) | 耗时 | 行数
├─ 刷新间隔(自动 5s / 手动)
└─ 导出 CSV
```

- 当前连接 Tab 单独展示(状态/Kill 复用现有 doMonitor)

### 2.6 权限要求与降级

| 数据源 | 最低权限 | 无权限时 |
|---|---|---|
| pg_stat_statements | pg_read_all_stats 或 superuser | 面板提示「需 superuser/pg_read_all_stats 权限」并禁用 |
| pg_stat_activity | 默认可见自己的连接；全量需 pg_read_all_stats | 显示部分行 |
| MySQL events_statements_history_long | performance_schema 开启即可 | 提示开启 |
| general_log | 需服务端开启 | 提示配置 |

### 2.7 实现步骤（工作量评估）

| 步骤 | 内容 | 工作量 |
|---|---|---|
| 1 | 后端 `doAuditHistory(conn, filters)`：PG/MySQL/SQLite 三方言查询 + 字段归一化 | 2-3h |
| 2 | 前端「历史操作」面板（过滤 + 表格 + 自动刷新 + 导出） | 2-3h |
| 3 | 服务器日志解析(PG CSV log) | 1-2h |
| 4 | 权限提示/降级处理 | 0.5h |

---

## 三、数据库对比（结构对比 + 数据对比 + 对比报告）

### 3.1 现状

已有：`doStructureSync`（单表结构 diff → ALTER 脚本）、`doDataSync`（单表主键级数据 diff → 合并脚本）、传输向导。**缺**：库级批量对比、纯对比报告（不执行）、忽略项/阈值配置、结果导出。

### 3.2 目标（对标 Navicat「数据库对比」）

```
结构对比(全库) ── 差异报表: 缺表/缺列/类型差异/索引差异/约束差异
数据对比(表级) ── 差异报表: 新增/删除/修改 行数 + 抽样示例 + 可生成同步脚本
```

### 3.3 技术方案

**A. 库级结构对比（复用 doStructureSync 核心，提升为批量）**

```
/api/compare/structure { srcConn, dstConn, srcDb, dstDb }
  1. 列出两端全部表(information_schema.tables / pg_tables)
  2. 并行对每表跑现有 readDef(columns/pk) 差异检测
  3. 汇总: { tables: [ { name, diff: [...], scripts: [...] } ],
            summary: { onlySrc, onlyDst, modified, identical, issues } }
  4. 输出纯报告模式(compareOnly=true → 不生成脚本或仅预览)
```

- 复用现有 `_tableDefCore`/`readDef` 三方言（PG/MySQL/SQLite 已支持）
- 差异类型扩展：除列级外，补 **索引差异**（`pg_indexes`/`SHOW INDEX`）与 **约束差异**（可选 P1）

**B. 数据对比（增强 doDataSync，新增报告模式 + 忽略项）**

```
/api/compare/data { srcConn, dstConn, schema, table, dstSchema, dstTable,
                    ignoreCols?, limit? }
  1. 主键/唯一键做交集比对(复用 doDataSync 逻辑)
  2. 差异分类: 仅源有(insert) / 仅目标有(delete) / 值不同(update)
  3. 每类返回计数 + 前 N 行示例(可配置 limit)
  4. compareOnly=true → 不执行,仅报告; 用户确认后可选生成脚本
```

- 忽略列（如 updated_at/审计列）→ 比对时排除
- 大表保护：抽样（LIMIT 1000）+ 行数对比（COUNT 一致则跳过逐行）

**C. 对比报告导出**

- 差异明细 → 导出 CSV / Markdown（前端表格 → 下载）

### 3.4 前端 UI 设计（「工具 → 数据库对比」向导，Navicat 式）

```
向导 4 步:
① 选择 源连接/库 与 目标连接/库（跨方言可选,复用传输向导）
② 范围: 全库 | 勾选表 | 结构/数据/两者
③ 选项: 忽略列 / 数据对比行数上限 / 仅生成报告
④ 结果页:
   ├─ 概要卡: 仅源N | 仅目标N | 已修改N | 一致N | 失败N
   ├─ 结构差异列表(表名→diff 明细→脚本预览/复制)
   ├─ 数据差异列表(表名→增/删/改 计数→抽样示例)
   ├─ 操作: [导出报告] [生成同步脚本] [执行到目标]
```

### 3.5 实现步骤（工作量评估）

| 步骤 | 内容 | 工作量 |
|---|---|---|
| 1 | 后端 `doCompareStructure(conn, conn)` 批量库级对比 + 报告结构 | 3-4h |
| 2 | 后端 `doCompareData` 报告模式 + 忽略列 + 抽样 | 2-3h |
| 3 | 前端对比向导 4 步 + 结果页 + 导出 | 3-4h |
| 4 | 复用传输向导的跨方言选择器 | 0.5h |

---

## 四、总体实施建议（增量,按性价比）

| 阶段 | 内容 | 工作量 | 价值 |
|---|---|---|---|
| **P0-1** | 历史操作面板（pg_stat_statements + activity + processlist） | 1 天 | ⭐⭐⭐ 满足核心需求 |
| **P0-2** | 数据库对比（结构对比报告 + 数据对比报告 + 导出） | 1-1.5 天 | ⭐⭐⭐ |
| **P1** | AI 助手(接 LLM + 结构注入) / 数据画像(Table Profile) / 跨库复制粘贴 / 可视化执行计划 | 各 1-2 天 | ⭐⭐ |
| **P2** | 数据生成器 / 查询构建器 / 表单视图 / 聚焦模式 / 代码片段 / 参数查询 | 各 0.5-1 天 | ⭐ |
| **P3** | 自动运行(计划任务) / BI / 模型工作区 / Kerberos | 大 | 远期 |

---

## 五、风险与前置条件

| 项 | 风险/前置 | 对策 |
|---|---|---|
| pg_stat_statements 未装 | 查询报错 | 面板提示安装指引(shared_preload_libraries + CREATE EXTENSION + 重启) |
| general_log 性能 | 全量记录有开销 | 默认用 performance_schema;general_log 作为可选开关 |
| 权限 | 非 superuser 看不到全量 | 降级显示 + 权限提示 |
| 对比大库 | 全库遍历慢 | 并行 + COUNT 预检 + 表数上限提示 |
| 跨方言对比 | PG↔MySQL 类型映射 | 复用 mapType(传输已实现) |
