import { ConnectionParams, DialectAdapter, DbType, ProtocolFamily } from './types';
import { MySqlDialect } from './mysql';
import { PostgresDialect } from './postgres';
import { SqliteDialect } from './sqlite';
import { StubDialect } from './stub';
import { getPreset, uiTypes } from '../presets';

// 方言注册表：按「协议族」映射驱动工厂。同族库（TiDB/OceanBase→mysql；openGauss→pg）
// 复用同一驱动，差异全部收敛到每库预设（presets/）。新增库只需在 presets 登记。
const familyFactories: Record<ProtocolFamily, (params: ConnectionParams) => DialectAdapter> = {
  mysql: (p) => new MySqlDialect(p),
  pg: (p) => new PostgresDialect(p),
  sqlite: (p) => new SqliteDialect(p),
  oracle: (p) => new StubDialect(p),
  mssql: (p) => new StubDialect(p),
  mongo: (p) => new StubDialect(p),
  dm: (p) => new StubDialect(p),
};

export function createDialect(params: ConnectionParams): DialectAdapter {
  const preset = getPreset(params.type);
  const factory = familyFactories[preset.family];
  if (!factory) throw new Error(`数据库类型 ${params.type} 的协议族 ${preset.family} 未注册驱动`);
  return factory(params);
}

export function supportedTypes(): DbType[] {
  return uiTypes();
}
