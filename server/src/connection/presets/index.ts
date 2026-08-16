// 预设注册表：按 DbType 查每库预设。
// 用法：getPreset('tidb') → 复用 mysql 族驱动 + 该库预设（端口 4000、树形态 db-table…）
import { DbPreset, DbType } from '../dialects/types';
import { PRESETS, BACKLOG_TYPES } from './presets';

const byType = new Map<DbType, DbPreset>(PRESETS.map((p) => [p.type, p]));

export function getPreset(type: DbType): DbPreset {
  const p = byType.get(type);
  if (!p) throw new Error(`未知数据库类型: ${type}`);
  return p;
}

// 前端连接向导可选的类型（排除 backlog）
export function uiTypes(): DbType[] {
  return PRESETS.filter((p) => !BACKLOG_TYPES.includes(p.type)).map((p) => p.type);
}

export function allPresets(): DbPreset[] {
  return PRESETS.slice();
}

export function isBacklog(type: DbType): boolean {
  return BACKLOG_TYPES.includes(type);
}
