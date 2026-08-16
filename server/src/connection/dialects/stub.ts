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

// 占位适配器：Oracle / SQL Server / MongoDB / Redis 在 P0 仅注册类型，
// 接口与真实适配器一致，后续按 DialectAdapter 增量实现，上层无需改动。
export class StubDialect implements DialectAdapter {
  readonly type: DbType;
  constructor(private params: ConnectionParams) {
    this.type = params.type;
  }

  private notImpl(): never {
    throw new Error(`数据库类型 "${this.params.type}" 的适配器将在后续阶段实现（P0 已注册类型）`);
  }

  async connect(): Promise<void> {
    this.notImpl();
  }
  async disconnect(): Promise<void> {
    this.notImpl();
  }
  async listDatabases(): Promise<string[]> {
    this.notImpl();
  }
  async listTables(): Promise<TableSummary[]> {
    this.notImpl();
  }
  async describeTable(): Promise<ColumnInfo[]> {
    this.notImpl();
  }
  async runQuery(): Promise<QueryResult> {
    this.notImpl();
  }
  classify(): StatementKind {
    return 'ddl';
  }
}
