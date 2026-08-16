// 与后端 server/src/connection/dialects/types.ts、presets/ 保持字段一致
// 10 种可选类型（达梦 dm / 金仓 kingbase 为 backlog，不进 UI）
export type DialectType =
  | 'mysql'
  | 'mariadb'
  | 'tidb'
  | 'oceanbase'
  | 'postgresql'
  | 'openGauss'
  | 'sqlite'
  | 'oracle'
  | 'mssql'
  | 'mongo';

export interface ConnectionConfig {
  type: DialectType;
  name?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  filePath?: string;
  readonly?: boolean;
  ssh?: { host: string; port: number; username: string; password?: string };
}

export interface ConnectionRecord extends ConnectionConfig {
  id: string;
}

export interface ColumnMeta {
  name: string;
  type: string;
  pk?: boolean;
  nullable?: boolean;
}

export interface QueryResult {
  columns: ColumnMeta[];
  rows: Record<string, unknown>[];
  rowCount: number;
  tookMs: number;
}

export type SqlKind = 'read' | 'write' | 'ddl' | 'other';
