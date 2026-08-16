import type {
  ConnectionConfig,
  ConnectionRecord,
  QueryResult,
  ColumnMeta,
} from './types';

// 后端 REST 前缀（开发时由 vite 代理到 :3000）
const BASE = '/api';

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as any)?.message || res.statusText;
    throw new Error(msg);
  }
  return data as T;
}

export const api = {
  listTypes: () => http<{ types: string[] }>('/connections/types'),

  listConnections: () => http<{ connections: ConnectionRecord[] }>('/connections'),

  createConnection: (cfg: ConnectionConfig) =>
    http<{ id: string; connection: ConnectionRecord }>('/connections', {
      method: 'POST',
      body: JSON.stringify(cfg),
    }),

  testConnection: (cfg: ConnectionConfig) =>
    http<{ ok: boolean; message?: string }>('/connections/test', {
      method: 'POST',
      body: JSON.stringify(cfg),
    }),

  deleteConnection: (id: string) =>
    http<{ ok: boolean }>(`/connections/${id}`, { method: 'DELETE' }),

  databases: (id: string) => http<{ databases: string[] }>(`/connections/${id}/databases`),

  tables: (id: string, database: string) =>
    http<{ tables: string[] }>(`/connections/${id}/databases/${encodeURIComponent(database)}/tables`),

  columns: (id: string, database: string, table: string) =>
    http<{ columns: ColumnMeta[] }>(
      `/connections/${id}/databases/${encodeURIComponent(database)}/tables/${encodeURIComponent(table)}/columns`,
    ),

  query: (id: string, sql: string, database?: string) =>
    http<QueryResult>(`/connections/${id}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql, database }),
    }),
};
