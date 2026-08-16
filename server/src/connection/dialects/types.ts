// 统一方言适配层类型定义。
// 目标：不同数据库都实现 DialectAdapter，上层（连接管理/UI）只依赖这套接口，
// 新增数据库只需补一个适配器（或复用协议族 + 填一张预设表），无需改动调用方。

export type DbType =
  | 'mysql'
  | 'mariadb'
  | 'tidb'
  | 'oceanbase'
  | 'postgres'
  | 'openGauss'
  | 'sqlite'
  | 'oracle'
  | 'mssql'
  | 'mongo'
  | 'dm'       // 达梦（backlog）
  | 'kingbase' // 人大金仓（backlog）
  | 'redis';

// 协议族：同族复用同一驱动与查询实现，差异收敛到 DbPreset
export type ProtocolFamily = 'mysql' | 'pg' | 'sqlite' | 'oracle' | 'mssql' | 'mongo' | 'dm';

// 连接表单字段描述（前端连接向导按 preset 动态渲染）
export type ConnectFieldType = 'text' | 'number' | 'password' | 'file' | 'checkbox';
export interface ConnectField {
  key: string;
  label: string;
  type: ConnectFieldType;
  default?: string | number | boolean;
  required?: boolean;
  placeholder?: string;
  // 仅当为真时显示（如 Oracle 的 SID/ServiceName 二选一）
  showWhen?: { key: string; value: string };
  help?: string;
}

// 每库预设（新库 = 复用协议族 + 填这张表）
export interface DbPreset {
  type: DbType;
  family: ProtocolFamily;
  label: string;                 // 前端显示名
  icon?: string;
  defaultPort?: number;
  connectFields: ConnectField[]; // 连接表单
  // SQL 方言
  quoteIdentifier: string;       // 标识符引用符，如 '"' '`' '[]'
  paramStyle: 'dollar' | 'question' | 'colon' | 'at'; // $1 / ? / :name / @p
  pagination: string;            // 分页模板说明（LIMIT x OFFSET y / ROWNUM / TOP / OFFSET-FETCH）
  autoIncrement: string;         // 自增写法说明
  // 元数据查询（可覆盖族默认实现）
  sql?: {
    listDatabases?: string;
    listTables?: string;
    describeTable?: string;
  };
  hiddenSystemSchemas?: string[]; // 对象树要隐藏的 system schema/库
  treeShape: 'db-table' | 'db-schema-table' | 'db-user-table' | 'collection'; // 对象树层级
  tools?: { dump?: string };      // 备份工具命令（mysqldump/pg_dump/…）
  capabilities: {                // 能力矩阵 → 前端禁用按钮
    sqlEditor: boolean;
    design: boolean;
    importExport: boolean;
    backup: boolean;
    userMgmt: boolean;
    monitor: boolean;
    er: boolean;
    structureSync: boolean;
    dataSync: boolean;
  };
  notes?: string; // 预设说明/差异提醒
}
  | 'mssql'
  | 'mongo'
  | 'redis';

export interface SslOptions {
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
}

export interface SshOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  privateKey?: string;
  privateKeyPass?: string;
}

export interface ConnectionParams {
  type: DbType;
  host?: string;
  port?: number;
  user?: string;
  // 运行时明文密码（由保险库解密后注入），不落盘
  password?: string;
  database?: string;
  // sqlite 专用
  filename?: string;
  ssl?: SslOptions;
  ssh?: SshOptions;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue?: string | null;
  primaryKey: boolean;
  comment?: string;
}

export interface TableSummary {
  schema?: string;
  name: string;
  type: string;
  rows?: number;
  comment?: string;
}

export interface QueryOpts {
  params?: any[];
  readonly?: boolean;
  maxRows?: number;
  timeoutMs?: number;
}

export interface QueryResult {
  columns: string[];
  // 行以数组形式返回（与 columns 一一对应），便于前端泛型渲染
  rows: any[][];
  rowCount: number;
  tookMs: number;
  truncated?: boolean;
}

// read = 查询；write = 增删改；ddl = 结构变更
export type StatementKind = 'read' | 'write' | 'ddl';

export interface DialectAdapter {
  readonly type: DbType;
  connect(params: ConnectionParams): Promise<void>;
  disconnect(): Promise<void>;
  listDatabases(): Promise<string[]>;
  listTables(db?: string): Promise<TableSummary[]>;
  describeTable(schema: string | undefined, table: string): Promise<ColumnInfo[]>;
  runQuery(sql: string, opts?: QueryOpts): Promise<QueryResult>;
  classify(sql: string): StatementKind;
}
