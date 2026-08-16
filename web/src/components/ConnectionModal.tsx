import { useState } from 'react';
import DBLogic from '../lib/db-logic';
const { validateConnection, defaultPort } = DBLogic;
import type { ConnectionConfig, DialectType } from '../types';

interface Props {
  onSave: (cfg: ConnectionConfig) => Promise<void> | void;
  onCancel: () => void;
}

// 前端连接向导预设（镜像 server/src/connection/presets）：类型 → 表单字段
const DBP_RESET: Record<string, { port: number | null; fields: [string, string, 'text' | 'number' | 'password' | 'file'][] }> = {
  mysql:     { port: 3306,  fields: [['host', '主机', 'text'], ['port', '端口', 'number'], ['user', '用户名', 'text'], ['password', '密码', 'password'], ['database', '数据库', 'text']] },
  mariadb:   { port: 3306,  fields: [['host', '主机', 'text'], ['port', '端口', 'number'], ['user', '用户名', 'text'], ['password', '密码', 'password'], ['database', '数据库', 'text']] },
  tidb:      { port: 4000,  fields: [['host', '主机', 'text'], ['port', '端口', 'number'], ['user', '用户名', 'text'], ['password', '密码', 'password'], ['database', '数据库', 'text']] },
  oceanbase: { port: 2881,  fields: [['host', '主机', 'text'], ['port', '端口', 'number'], ['user', '用户名', 'text'], ['password', '密码', 'password'], ['database', '数据库', 'text']] },
  postgresql:{ port: 5432,  fields: [['host', '主机', 'text'], ['port', '端口', 'number'], ['user', '用户名', 'text'], ['password', '密码', 'password'], ['database', '数据库', 'text']] },
  openGauss: { port: 5432,  fields: [['host', '主机', 'text'], ['port', '端口', 'number'], ['user', '用户名', 'text'], ['password', '密码', 'password'], ['database', '数据库', 'text']] },
  sqlite:    { port: null,  fields: [['filePath', 'SQLite 文件路径', 'file']] },
  oracle:    { port: 1521,  fields: [['host', '主机', 'text'], ['port', '端口', 'number'], ['user', '用户名', 'text'], ['password', '密码', 'password'], ['database', '服务名', 'text']] },
  mssql:     { port: 1433,  fields: [['host', '主机', 'text'], ['port', '端口', 'number'], ['user', '用户名', 'text'], ['password', '密码', 'password'], ['database', '数据库', 'text']] },
  mongo:     { port: 27017, fields: [['host', '主机', 'text'], ['port', '端口', 'number'], ['user', '用户名', 'text'], ['password', '密码', 'password'], ['database', '默认库', 'text']] },
};
const DBP_LABEL: Record<string, string> = {
  mysql: 'MySQL', mariadb: 'MariaDB', tidb: 'TiDB', oceanbase: 'OceanBase',
  postgresql: 'PostgreSQL', openGauss: 'openGauss', sqlite: 'SQLite',
  oracle: 'Oracle', mssql: 'SQL Server', mongo: 'MongoDB',
};

export function ConnectionModal({ onSave, onCancel }: Props) {
  const [type, setType] = useState<DialectType>('mysql');
  const [vals, setVals] = useState<Record<string, string>>({ host: '127.0.0.1', port: String(defaultPort('mysql')) });
  const [readonly, setReadonly] = useState(false);
  const [err, setErr] = useState<string[]>([]);
  const [warn, setWarn] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const onType = (t: DialectType) => {
    setType(t);
    const p = DBP_RESET[t];
    setVals({ host: '127.0.0.1', port: p.port ? String(p.port) : '' });
  };

  const setVal = (k: string, v: string) => setVals((prev) => ({ ...prev, [k]: v }));

  const submit = async () => {
    const p = DBP_RESET[type];
    const cfg: ConnectionConfig = { type, readonly };
    p.fields.forEach(([key]) => {
      const v = (vals[key] ?? '').trim();
      if (key === 'port') cfg.port = parseInt(v, 10) || (p.port ?? undefined);
      else if (key === 'user') cfg.username = v;
      else if (key === 'filePath') cfg.filePath = v;
      else if (key === 'password') cfg.password = vals[key] ?? '';
      else if (key === 'database') cfg.database = v;
      else if (key === 'host') cfg.host = v;
    });
    const r = validateConnection(cfg);
    setErr(r.errors);
    setWarn(r.warnings);
    if (!r.valid) return;
    setBusy(true);
    try {
      await onSave(cfg);
    } finally {
      setBusy(false);
    }
  };

  const p = DBP_RESET[type];

  return (
    <div className="modal show">
      <div className="card">
        <h3>新建连接</h3>
        <div className="field">
          <label>类型</label>
          <select value={type} onChange={(e) => onType(e.target.value as DialectType)}>
            {Object.keys(DBP_RESET).map((t) => (
              <option key={t} value={t}>
                {DBP_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        {p.fields.map(([key, label, kind]) => (
          <div className="field" key={key}>
            <label>{label}</label>
            {kind === 'file' ? (
              <input value={vals[key] ?? ''} placeholder=".db 文件绝对路径（不存在会自动创建）" onChange={(e) => setVal(key, e.target.value)} />
            ) : (
              <input
                type={kind === 'password' ? 'password' : kind === 'number' ? 'number' : 'text'}
                value={vals[key] ?? ''}
                onChange={(e) => setVal(key, e.target.value)}
              />
            )}
          </div>
        ))}
        <div className="field">
          <label>
            <input type="checkbox" checked={readonly} onChange={(e) => setReadonly(e.target.checked)} /> 只读连接
          </label>
        </div>
        {err.map((e, i) => (
          <div className="err" key={i}>
            {e}
          </div>
        ))}
        {warn.map((w, i) => (
          <div className="warn" key={i}>
            {w}
          </div>
        ))}
        <div className="actions">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" disabled={busy} onClick={submit}>
            {busy ? '连接中…' : '保存并连接'}
          </button>
        </div>
      </div>
    </div>
  );
}
