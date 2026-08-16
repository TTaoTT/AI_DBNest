// SQLite 适配器：使用 Node 22 内置的 node:sqlite（无需原生编译依赖）。
// 注意：node:sqlite 当前为实验性 API，生产化时可平滑替换为 better-sqlite3。
// @ts-ignore - node:sqlite 类型尚未在 @types/node 稳定提供
import { DatabaseSync } from 'node:sqlite';
import {
  ConnectionParams,
  DialectAdapter,
  ColumnInfo,
  TableSummary,
  QueryOpts,
  QueryResult,
  StatementKind,
  DbType,
} from './types';

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export class SqliteDialect implements DialectAdapter {
  readonly type: DbType;

  constructor(private params: ConnectionParams) {
    this.type = params.type;
  }
  private db?: DatabaseSync;

  async connect() {
    const file = this.params.filename ?? ':memory:';
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  async disconnect() {
    this.db?.close();
  }

  async listDatabases(): Promise<string[]> {
    return [this.params.filename ?? ':memory:'];
  }

  async listTables(): Promise<TableSummary[]> {
    const rows = this.db!
      .prepare(
        `SELECT name, type FROM sqlite_master
         WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as any[];
    return rows.map((r) => ({ schema: undefined, name: r.name, type: r.type === 'view' ? 'VIEW' : 'BASE TABLE' }));
  }

  async describeTable(_schema: string | undefined, table: string): Promise<ColumnInfo[]> {
    const rows = this.db!.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as any[];
    return rows.map((c) => ({
      name: c.name,
      dataType: c.type,
      nullable: c.notnull === 0,
      defaultValue: c.dflt_value ?? null,
      primaryKey: c.pk === 1,
    }));
  }

  async runQuery(sql: string, opts?: QueryOpts): Promise<QueryResult> {
    const start = Date.now();
    const kind = this.classify(sql);
    let arr: any[] = [];
    if (kind === 'read') {
      arr = this.db!.prepare(sql).all(...(opts?.params ?? [])) as any[];
    } else {
      this.db!.prepare(sql).run(...(opts?.params ?? [])); // DDL/DML：支持占位符，无结果集
    }
    const columns = arr.length ? Object.keys(arr[0]) : [];
    const max = opts?.maxRows ?? 10000;
    const truncated = arr.length > max;
    const sliced = truncated ? arr.slice(0, max) : arr;
    const dataRows = sliced.map((row) => columns.map((c) => row[c]));
    return { columns, rows: dataRows, rowCount: arr.length, tookMs: Date.now() - start, truncated };
  }

  classify(sql: string): StatementKind {
    const s = sql.trim().toLowerCase();
    if (/^\s*(select|with|pragma|explain)\b/.test(s)) return 'read';
    if (/^\s*(insert|update|delete|replace)\b/.test(s)) return 'write';
    return 'ddl';
  }
}
