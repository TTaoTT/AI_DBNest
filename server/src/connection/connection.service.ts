import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { VaultService } from './vault.service';
import { CreateConnectionDto, ExecuteQueryDto } from './dto';
import { createDialect } from './dialects';
import {
  ConnectionParams,
  DialectAdapter,
  DbType,
  SslOptions,
  SshOptions,
  TableSummary,
  ColumnInfo,
  QueryResult,
} from './dialects/types';

interface StoredConnection {
  id: string;
  name: string;
  type: DbType;
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  filename?: string;
  ssl?: SslOptions;
  ssh?: SshOptions;
  passwordEnc?: string;
}

const STORE_FILE = path.join(process.cwd(), 'connections.json');

@Injectable()
export class ConnectionService {
  private store = new Map<string, StoredConnection>();
  private adapters = new Map<string, DialectAdapter>();

  constructor(private vault: VaultService) {
    this.load();
  }

  private load() {
    if (fs.existsSync(STORE_FILE)) {
      const list = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) as StoredConnection[];
      list.forEach((c) => this.store.set(c.id, c));
    }
  }

  private persist() {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...this.store.values()], null, 2), { mode: 0o600 });
  }

  list(): StoredConnection[] {
    // 不返回密码字段
    return [...this.store.values()].map(({ passwordEnc, ...rest }) => rest as StoredConnection);
  }

  async create(dto: CreateConnectionDto): Promise<StoredConnection> {
    const id = crypto.randomUUID();
    const stored: StoredConnection = {
      id,
      name: dto.name,
      type: dto.type,
      host: dto.host,
      port: dto.port,
      user: dto.user,
      database: dto.database,
      filename: dto.filename,
      ssl: dto.ssl,
      ssh: dto.ssh,
    };
    if (dto.password) stored.passwordEnc = this.vault.encrypt(dto.password);
    this.store.set(id, stored);
    this.persist();
    const { passwordEnc, ...rest } = stored;
    return rest as StoredConnection;
  }

  remove(id: string): void {
    this.store.delete(id);
    this.persist();
    void this.adapters.get(id)?.disconnect();
    this.adapters.delete(id);
  }

  // 把存储的连接还原成运行时参数（解密密码）
  private resolveParams(c: StoredConnection): ConnectionParams {
    return {
      type: c.type,
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.passwordEnc ? this.vault.decrypt(c.passwordEnc) : undefined,
      database: c.database,
      filename: c.filename,
      ssl: c.ssl,
      ssh: c.ssh,
    };
  }

  private async getAdapter(id: string): Promise<DialectAdapter> {
    const cached = this.adapters.get(id);
    if (cached) return cached;
    const c = this.store.get(id);
    if (!c) throw new NotFoundException(`连接不存在: ${id}`);
    const adapter = createDialect(this.resolveParams(c));
    await adapter.connect();
    this.adapters.set(id, adapter);
    return adapter;
  }

  async test(dto: CreateConnectionDto): Promise<{ ok: boolean; message: string }> {
    const adapter = createDialect({
      type: dto.type,
      host: dto.host,
      port: dto.port,
      user: dto.user,
      password: dto.password,
      database: dto.database,
      filename: dto.filename,
      ssl: dto.ssl,
      ssh: dto.ssh,
    });
    try {
      await adapter.connect();
      await adapter.disconnect();
      return { ok: true, message: '连接成功' };
    } catch (e: any) {
      return { ok: false, message: e?.message ?? '连接失败' };
    }
  }

  async getDatabases(id: string): Promise<string[]> {
    return this.getAdapter(id).then((a) => a.listDatabases());
  }

  async getTables(id: string, db?: string): Promise<TableSummary[]> {
    return this.getAdapter(id).then((a) => a.listTables(db));
  }

  async describeTable(id: string, schema: string | undefined, table: string): Promise<ColumnInfo[]> {
    return this.getAdapter(id).then((a) => a.describeTable(schema, table));
  }

  async executeQuery(id: string, dto: ExecuteQueryDto): Promise<QueryResult> {
    const adapter = await this.getAdapter(id);
    if (dto.readonly && adapter.classify(dto.sql) !== 'read') {
      throw new ForbiddenException('只读连接不允许执行写/结构变更语句');
    }
    return adapter.runQuery(dto.sql, {
      params: dto.params,
      readonly: dto.readonly,
      maxRows: dto.maxRows,
    });
  }
}
