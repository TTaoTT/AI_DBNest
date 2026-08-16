import mysql from 'mysql2/promise';
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

// MySQL / MariaDB / TiDB / OceanBase 适配器（mysql2 为纯 JS 驱动，跨平台零原生依赖；
// 同协议族库复用本适配器，差异由每库预设驱动）。
export class MySqlDialect implements DialectAdapter {
  readonly type: DbType;
  private pool?: mysql.Pool;

  constructor(private params: ConnectionParams) {
    this.type = params.type;
  }

  async connect() {
    this.pool = mysql.createPool({
      host: this.params.host,
      port: this.params.port ?? 3306,
      user: this.params.user,
      password: this.params.password,
      database: this.params.database,
      connectionLimit: 5,
      waitForConnections: true,
      connectTimeout: 10000,
    });
    // 探活
    await this.pool.query('SELECT 1');
  }

  async disconnect() {
    await this.pool?.end();
  }

  async listDatabases(): Promise<string[]> {
    const [rows] = await this.pool!.query('SHOW DATABASES');
    return (rows as any[]).map((r) => Object.values(r)[0] as string);
  }

  async listTables(db?: string): Promise<TableSummary[]> {
    const database = db ?? this.params.database;
    if (!database) return [];
    const [rows] = await this.pool!.query(
      `SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT, TABLE_ROWS
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
      [database],
    );
    return (rows as any[]).map((r) => ({
      schema: database,
      name: r.TABLE_NAME,
      type: r.TABLE_TYPE,
      rows: Number(r.TABLE_ROWS),
      comment: r.TABLE_COMMENT,
    }));
  }

  async describeTable(schema: string | undefined, table: string): Promise<ColumnInfo[]> {
    const database = schema ?? this.params.database;
    const [rows] = await this.pool!.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, COLUMN_COMMENT
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [database, table],
    );
    return (rows as any[]).map((c) => ({
      name: c.COLUMN_NAME,
      dataType: c.COLUMN_TYPE,
      nullable: c.IS_NULLABLE === 'YES',
      defaultValue: c.COLUMN_DEFAULT ?? null,
      primaryKey: c.COLUMN_KEY === 'PRI',
      comment: c.COLUMN_COMMENT,
    }));
  }

  async runQuery(sql: string, opts?: QueryOpts): Promise<QueryResult> {
    const start = Date.now();
    const [rows, fields] = await this.pool!.query(
      { sql, values: opts?.params ?? [], rowsAsArray: false },
    );
    const arr = (rows as any[]) ?? [];
    const columns = (fields as any[])?.map((f) => f.name) ?? (arr[0] ? Object.keys(arr[0]) : []);
    const max = opts?.maxRows ?? 10000;
    const truncated = arr.length > max;
    const sliced = truncated ? arr.slice(0, max) : arr;
    const dataRows = sliced.map((r) => columns.map((c) => r[c]));
    return { columns, rows: dataRows, rowCount: arr.length, tookMs: Date.now() - start, truncated };
  }

  classify(sql: string): StatementKind {
    const s = sql.trim().toLowerCase();
    if (/^\s*(select|show|describe|desc|explain|with|use|pragma|call)\b/.test(s)) return 'read';
    if (/^\s*(insert|update|delete|replace)\b/.test(s)) return 'write';
    return 'ddl';
  }
}
