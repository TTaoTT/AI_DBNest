import { DbType, SslOptions, SshOptions } from './dialects/types';

export class CreateConnectionDto {
  name: string;
  type: DbType;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  filename?: string;
  ssl?: SslOptions;
  ssh?: SshOptions;
}

export class ExecuteQueryDto {
  sql: string;
  params?: any[];
  readonly?: boolean;
  maxRows?: number;
}
