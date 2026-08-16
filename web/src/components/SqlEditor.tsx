import Editor from '@monaco-editor/react';
import { useState } from 'react';
import DBLogic from '../lib/db-logic';
const { classifySql, detectDangerous } = DBLogic;
import type { SqlKind } from '../types';

interface Props {
  value: string;
  readonly?: boolean;
  onChange: (v: string) => void;
  onRun: (sql: string) => void;
}

export function SqlEditor({ value, readonly, onChange, onRun }: Props) {
  const [kind, setKind] = useState<SqlKind>('read');
  const [danger, setDanger] = useState<string[]>([]);

  const analyze = (sql: string) => {
    setKind(classifySql(sql));
    setDanger(detectDangerous(sql).map((d) => d.reason));
  };

  const run = () => {
    analyze(value);
    // 只读守卫与危险确认统一交给 App 层处理（App 持有连接只读状态与后端）
    onRun(value);
  };

  return (
    <div className="sql-editor">
      <div className="sql-toolbar">
        <button className="btn primary" disabled={!value.trim()} onClick={run}>
          ▶ 运行
        </button>
        <span className={`badge ${kind}`}>
          {kind === 'read' ? '只读查询' : kind === 'write' ? '数据写入' : kind === 'ddl' ? '结构变更' : '其他'}
        </span>
        {readonly && <span className="hint">只读连接将拦截写/DDL</span>}
        {danger.length > 0 && <span className="badge ddl">⚠ {danger.length} 项危险操作</span>}
      </div>
      {danger.length > 0 && (
        <div className="confirm-box">
          {danger.map((d, i) => (
            <div key={i}>• {d}</div>
          ))}
        </div>
      )}
      <Editor
        height="200px"
        defaultLanguage="sql"
        value={value}
        onChange={(v) => {
          onChange(v ?? '');
          analyze(v ?? '');
        }}
        options={{ minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false }}
      />
    </div>
  );
}
