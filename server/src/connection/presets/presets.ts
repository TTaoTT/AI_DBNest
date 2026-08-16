// 各数据库预设表（每库一张，族默认实现见 mysql-family / pg-family）
import { DbPreset, DbType } from '../dialects/types';
import { commonFields } from './base';

const mysqlFamily = {
  quoteIdentifier: '`',
  paramStyle: 'question' as const,
  pagination: 'LIMIT x OFFSET y',
  autoIncrement: 'AUTO_INCREMENT',
  hiddenSystemSchemas: ['mysql', 'sys', 'information_schema', 'performance_schema'],
  treeShape: 'db-table' as const,
};

export const PRESETS: DbPreset[] = [
  // ---------- MySQL 协议族 ----------
  {
    type: 'mysql', family: 'mysql', label: 'MySQL', icon: '🐬', defaultPort: 3306,
    connectFields: commonFields(3306),
    ...mysqlFamily,
    capabilities: { sqlEditor: true, design: true, importExport: true, backup: true, userMgmt: true, monitor: true, er: true, structureSync: true, dataSync: true },
    sql: {
      listTables: "SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name",
    },
  },
  {
    type: 'mariadb', family: 'mysql', label: 'MariaDB', icon: '🍃', defaultPort: 3306,
    connectFields: commonFields(3306),
    ...mysqlFamily,
    capabilities: { sqlEditor: true, design: true, importExport: true, backup: true, userMgmt: true, monitor: true, er: true, structureSync: true, dataSync: true },
    notes: '协议兼容 MySQL；注意 JSON 类型、窗口函数等版本差异',
  },
  {
    type: 'tidb', family: 'mysql', label: 'TiDB', icon: '⚡', defaultPort: 4000,
    connectFields: commonFields(4000),
    ...mysqlFamily,
    capabilities: { sqlEditor: true, design: true, importExport: true, backup: true, userMgmt: true, monitor: true, er: true, structureSync: true, dataSync: true },
    notes: 'MySQL 协议兼容；分布式特性：DDL 在线执行、分区表语法同 MySQL',
  },
  {
    type: 'oceanbase', family: 'mysql', label: 'OceanBase', icon: '🌊', defaultPort: 2881,
    connectFields: commonFields(2881),
    ...mysqlFamily,
    capabilities: { sqlEditor: true, design: true, importExport: true, backup: true, userMgmt: true, monitor: true, er: true, structureSync: true, dataSync: true },
    notes: '以 MySQL 兼容模式接入；租户内为独立库空间',
  },

  // ---------- PG 协议族 ----------
  {
    type: 'postgres', family: 'pg', label: 'PostgreSQL', icon: '🐘', defaultPort: 5432,
    connectFields: commonFields(5432),
    quoteIdentifier: '"', paramStyle: 'dollar',
    pagination: 'LIMIT x OFFSET y',
    autoIncrement: 'GENERATED AS IDENTITY / SERIAL',
    hiddenSystemSchemas: ['pg_catalog', 'information_schema'],
    treeShape: 'db-schema-table',
    capabilities: { sqlEditor: true, design: true, importExport: true, backup: true, userMgmt: true, monitor: true, er: true, structureSync: true, dataSync: true },
    sql: {
      listTables: "SELECT tablename AS name, 'TABLE' AS type FROM pg_tables WHERE schemaname = ? UNION SELECT viewname AS name, 'VIEW' AS type FROM pg_views WHERE schemaname = ? ORDER BY name",
    },
  },
  {
    type: 'openGauss', family: 'pg', label: 'openGauss', icon: '🐧', defaultPort: 5432,
    connectFields: commonFields(5432),
    quoteIdentifier: '"', paramStyle: 'dollar',
    pagination: 'LIMIT x OFFSET y',
    autoIncrement: 'GENERATED AS IDENTITY / SERIAL',
    hiddenSystemSchemas: ['pg_catalog', 'information_schema', 'dbe_perf', 'snapshot'],
    treeShape: 'db-schema-table',
    capabilities: { sqlEditor: true, design: true, importExport: true, backup: true, userMgmt: true, monitor: true, er: true, structureSync: true, dataSync: true },
    notes: 'PG 内核兼容；系统视图有差异（gs_* 前缀），元数据 SQL 需按库覆盖',
  },

  // ---------- 独立驱动 ----------
  {
    type: 'sqlite', family: 'sqlite', label: 'SQLite', icon: '🗄️',
    connectFields: [
      { key: 'filename', label: '数据库文件', type: 'file', required: true, placeholder: '.db 文件绝对路径（不存在会自动创建）' },
    ],
    quoteIdentifier: '"', paramStyle: 'question',
    pagination: 'LIMIT x OFFSET y',
    autoIncrement: 'INTEGER PRIMARY KEY AUTOINCREMENT',
    hiddenSystemSchemas: [],
    treeShape: 'db-table',
    capabilities: { sqlEditor: true, design: false, importExport: true, backup: true, userMgmt: false, monitor: false, er: false, structureSync: false, dataSync: true },
    notes: '单文件库；ALTER 能力有限，设计器仅展示结构',
  },
  {
    type: 'oracle', family: 'oracle', label: 'Oracle', icon: '🟥', defaultPort: 1521,
    connectFields: [
      ...commonFields(1521),
      { key: 'serviceName', label: '服务名 ServiceName', type: 'text', placeholder: 'ORCL' },
      { key: 'sid', label: 'SID', type: 'text', help: 'ServiceName 与 SID 二选一' },
    ],
    quoteIdentifier: '"', paramStyle: 'colon',
    pagination: 'ROWNUM / OFFSET x ROWS FETCH NEXT y ROWS ONLY',
    autoIncrement: 'GENERATED AS IDENTITY / SEQUENCE',
    hiddenSystemSchemas: ['SYS', 'SYSTEM'],
    treeShape: 'db-user-table',
    capabilities: { sqlEditor: true, design: true, importExport: true, backup: true, userMgmt: true, monitor: true, er: true, structureSync: true, dataSync: true },
    notes: '需 oracledb 原生驱动（预编译二进制）；连接需 ServiceName 或 SID',
  },
  {
    type: 'mssql', family: 'mssql', label: 'SQL Server', icon: '🟦', defaultPort: 1433,
    connectFields: [
      ...commonFields(1433),
      { key: 'instance', label: '实例名', type: 'text', help: '可选，形如 SQLEXPRESS' },
      { key: 'integrated', label: 'Windows 集成认证', type: 'checkbox', default: false },
    ],
    quoteIdentifier: '[]', paramStyle: 'at',
    pagination: 'OFFSET x ROWS FETCH NEXT y ROWS ONLY / TOP n',
    autoIncrement: 'IDENTITY(1,1)',
    hiddenSystemSchemas: ['sys', 'INFORMATION_SCHEMA'],
    treeShape: 'db-schema-table',
    capabilities: { sqlEditor: true, design: true, importExport: true, backup: true, userMgmt: true, monitor: true, er: true, structureSync: true, dataSync: true },
    notes: '需 mssql 驱动；Windows 集成认证需额外配置',
  },
  {
    type: 'mongo', family: 'mongo', label: 'MongoDB', icon: '🍃', defaultPort: 27017,
    connectFields: [
      ...commonFields(27017, '默认库'),
      { key: 'authSource', label: '认证库', type: 'text', default: 'admin' },
    ],
    quoteIdentifier: '', paramStyle: 'colon',
    pagination: 'N/A（游标）',
    autoIncrement: 'N/A',
    hiddenSystemSchemas: ['admin', 'local', 'config'],
    treeShape: 'collection',
    capabilities: { sqlEditor: true, design: false, importExport: true, backup: true, userMgmt: true, monitor: true, er: false, structureSync: false, dataSync: false },
    notes: '文档型数据库：无 SQL 方言，对象树为 库→集合，查询用 JSON 语法',
  },

  // ---------- backlog（先注册不进 UI 主列表） ----------
  {
    type: 'dm', family: 'dm', label: '达梦 DM', icon: '🎯', defaultPort: 5236,
    connectFields: commonFields(5236),
    quoteIdentifier: '"', paramStyle: 'colon',
    pagination: 'ROWNUM / OFFSET-FETCH',
    autoIncrement: 'IDENTITY(1,1)',
    hiddenSystemSchemas: ['SYS', 'SYSDBA'],
    treeShape: 'db-user-table',
    capabilities: { sqlEditor: true, design: true, importExport: true, backup: true, userMgmt: true, monitor: true, er: true, structureSync: true, dataSync: true },
    notes: 'backlog：驱动方案待评估（官方 Node 驱动 / JDBC bridge）',
  },
  {
    type: 'kingbase', family: 'pg', label: '人大金仓 KingbaseES', icon: '👑', defaultPort: 54321,
    connectFields: commonFields(54321),
    quoteIdentifier: '"', paramStyle: 'dollar',
    pagination: 'LIMIT x OFFSET y',
    autoIncrement: 'SERIAL / GENERATED AS IDENTITY',
    hiddenSystemSchemas: ['pg_catalog', 'information_schema', 'sys_catalog'],
    treeShape: 'db-schema-table',
    capabilities: { sqlEditor: true, design: true, importExport: true, backup: true, userMgmt: true, monitor: true, er: true, structureSync: true, dataSync: true },
    notes: 'backlog：PG 协议兼容，仅需预设 + 元数据 SQL 微调',
  },
];

export const BACKLOG_TYPES: DbType[] = ['dm', 'kingbase'];
