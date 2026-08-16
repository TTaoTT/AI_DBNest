import { PgWire } from './pgwire';
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

// PostgreSQL / openGauss / KingbaseES 适配器（零依赖：使用自研 pgwire 客户端，
// 无需安装 pg 原生/JS 驱动；同协议族库复用本适配器，差异由每库预设驱动）。
export class PostgresDialect implements DialectAdapter {
  readonly type: DbType;
  private wire?: PgWire;

  constructor(private params: ConnectionParams) {
    this.type = params.type;
  }

  async connect() {
    this.wire = new PgWire({
      host: this.params.host,
      port: this.params.port ?? 5432,
      user: this.params.user,
      password: this.params.password,
      database: this.params.database,
    });
    await this.wire.connect();
  }

  async disconnect() {
    this.wire?.end();
  }

  async listDatabases(): Promise<string[]> {
    const r = await this.wire!.query(
      `SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`,
    );
    return r.rows.map((row) => row.datname);
  }

  async listTables(db?: string): Promise<TableSummary[]> {
    const r = await this.wire!.query(
      `SELECT n.nspname AS schema, c.relname AS name,
              CASE c.relkind WHEN 'v' THEN 'VIEW' ELSE 'BASE TABLE' END AS type,
              pg_total_relation_size(c.oid) AS bytes
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','v') AND n.nspname NOT IN ('pg_catalog','information_schema')
       ORDER BY n.nspname, c.relname`,
    );
    return r.rows.map((row) => ({
      schema: row.schema,
      name: row.name,
      type: row.type,
      rows: undefined,
    }));
  }

  async describeTable(schema: string | undefined, table: string): Promise<ColumnInfo[]> {
    const sch = schema ?? 'public';
    const r = await this.wire!.query(
      `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS dataType,
              NOT a.attnotnull AS nullable, d.adsrc AS default,
              (i.indisprimary IS NOT NULL) AS pk
       FROM pg_attribute a
       LEFT JOIN pg_index i ON i.indrelid = a.attrelid AND a.attnum = ANY(i.indkey) AND i.indisprimary
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = ($1 || '.' || $2)::regclass AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [sch, table] as any,
    );
    return r.rows.map((c) => ({
      name: c.name,
      dataType: c.datatype,
      nullable: c.nullable === 't',
      defaultValue: c.default ?? null,
      primaryKey: c.pk === 't',
    }));
  }

  async runQuery(sql: string, opts?: QueryOpts): Promise<QueryResult> {
    const start = Date.now();
    const r = await this.wire!.query(sql);
    const columns = r.fields.map((f) => f.name);
    const arr = r.rows ?? [];
    const max = opts?.maxRows ?? 10000;
    const truncated = arr.length > max;
    const sliced = truncated ? arr.slice(0, max) : arr;
    const dataRows = sliced.map((row) => columns.map((c) => row[c]));
    return { columns, rows: dataRows, rowCount: arr.length, tookMs: Date.now() - start, truncated };
  }

  classify(sql: string): StatementKind {
    const s = sql.trim().toLowerCase();
    if (/^\s*(select|with|show|explain|describe|desc|table)\b/.test(s)) return 'read';
    if (/^\s*(insert|update|delete|merge)\b/.test(s)) return 'write';
    return 'ddl';
  }
}
