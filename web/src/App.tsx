import { useCallback, useEffect, useState } from 'react';
import { api } from './api/client';
import { ConnectionManager } from './components/ConnectionManager';
import { ConnectionModal } from './components/ConnectionModal';
import { ObjectTree } from './components/ObjectTree';
import { DataGrid } from './components/DataGrid';
import { SqlEditor } from './components/SqlEditor';
import DBLogic from './lib/db-logic';
const { classifySql, detectDangerous } = DBLogic;
import type { ConnectionConfig, ConnectionRecord, ColumnMeta, QueryResult } from './types';

type Tab = 'grid' | 'sql';

export function App() {
  const [connections, setConnections] = useState<ConnectionRecord[]>([]);
  const [active, setActive] = useState<ConnectionRecord | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [tablesByDb, setTablesByDb] = useState<Record<string, string[]>>({});
  const [activeTable, setActiveTable] = useState<string | undefined>();
  const [activeDb, setActiveDb] = useState<string | undefined>();
  const [columns, setColumns] = useState<ColumnMeta[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [tab, setTab] = useState<Tab>('grid');
  const [sql, setSql] = useState('SELECT * FROM users LIMIT 200;');
  const [showModal, setShowModal] = useState(false);
  const [status, setStatus] = useState('就绪');
  const [statusErr, setStatusErr] = useState(false);
  const [loading, setLoading] = useState(false);

  const setMsg = (m: string, err = false) => {
    setStatus(m);
    setStatusErr(err);
  };

  useEffect(() => {
    api.listConnections().then((r) => setConnections(r.connections)).catch((e) => setMsg(String(e.message), true));
  }, []);

  const selectConnection = useCallback(async (c: ConnectionRecord) => {
    setActive(c);
    setActiveTable(undefined);
    setColumns([]);
    setRows([]);
    setLoading(true);
    try {
      const dbs = await api.databases(c.id);
      setDatabases(dbs.databases);
      const map: Record<string, string[]> = {};
      for (const db of dbs.databases) map[db] = (await api.tables(c.id, db)).tables;
      setTablesByDb(map);
      setMsg('已连接：' + (c.name || c.type) + (c.readonly ? '（只读）' : ''));
    } catch (e: any) {
      setMsg(String(e.message), true);
    } finally {
      setLoading(false);
    }
  }, []);

  const selectTable = useCallback(
    async (database: string, table: string) => {
      if (!active) return;
      setActiveDb(database);
      setActiveTable(table);
      setTab('grid');
      setLoading(true);
      try {
        const cols = await api.columns(active.id, database, table);
        setColumns(cols.columns);
        const res = await api.query(active.id, `SELECT * FROM ${table} LIMIT 200`, database);
        setRows(res.rows);
        setMsg(`已加载 ${table} · ${res.rowCount} 行 · ${res.tookMs}ms`);
      } catch (e: any) {
        setMsg(String(e.message), true);
      } finally {
        setLoading(false);
      }
    },
    [active],
  );

  const onSaveConn = useCallback(
    async (cfg: ConnectionConfig) => {
      const r = await api.createConnection(cfg);
      setConnections((prev) => [...prev, r.connection]);
      setShowModal(false);
      await selectConnection(r.connection);
    },
    [selectConnection],
  );

  const onDeleteConn = useCallback(async (id: string) => {
    await api.deleteConnection(id);
    setConnections((prev) => prev.filter((c) => c.id !== id));
    if (active?.id === id) setActive(null);
  }, [active]);

  const runSql = useCallback(
    async (raw: string) => {
      if (!active) return setMsg('请先选择连接', true);
      const kind = classifySql(raw);
      // 客户端只读守卫（与后端一致）
      if (active.readonly && kind !== 'read') {
        return setMsg('⛔ 只读连接拒绝执行 ' + ({ write: '写入', ddl: '结构变更' }[kind] || '非只读') + ' 语句', true);
      }
      // 危险确认（客户端提示，后端仍会二次保护）
      const danger = detectDangerous(raw);
      if (danger.length && !confirm('危险操作：\n' + danger.map((d) => '• ' + d.reason).join('\n') + '\n确认执行？')) {
        return;
      }
      setLoading(true);
      try {
        const res: QueryResult = await api.query(active.id, raw, activeDb);
        setColumns(res.columns);
        setRows(res.rows);
        setTab('grid');
        setMsg(`执行成功 · ${res.rowCount} 行 · ${res.tookMs}ms`);
      } catch (e: any) {
        setMsg(String(e.message), true);
      } finally {
        setLoading(false);
      }
    },
    [active, activeDb],
  );

  return (
    <div className="app">
      <header className="topbar">
        <h1>DB Admin</h1>
        <span className="tag">对标 Navicat · React + Vite + 虚拟表格 + Monaco</span>
      </header>
      <div className="layout">
        <aside className="sidebar">
          <ConnectionManager
            connections={connections}
            activeId={active?.id}
            onSelect={selectConnection}
            onDelete={onDeleteConn}
            onNew={() => setShowModal(true)}
          />
        </aside>
        <section className="objects">
          <ObjectTree databases={databases} tablesByDb={tablesByDb} activeTable={activeTable} onSelectTable={selectTable} />
        </section>
        <main className="workspace">
          <div className="toolbar">
            <div className="seg">
              <button className={tab === 'grid' ? 'on' : ''} onClick={() => setTab('grid')}>
                数据网格
              </button>
              <button className={tab === 'sql' ? 'on' : ''} onClick={() => setTab('sql')}>
                SQL 编辑器
              </button>
            </div>
            <span className="hint">{loading ? '加载中…' : ''}</span>
          </div>
          {tab === 'grid' ? (
            <DataGrid columns={columns} rows={rows} readonly={active?.readonly} />
          ) : (
            <SqlEditor value={sql} readonly={active?.readonly} onChange={setSql} onRun={runSql} />
          )}
          <div className={'statusbar' + (statusErr ? ' err' : '')}>
            <span>行数：{rows.length.toLocaleString()}</span>
            <span>{status}</span>
          </div>
        </main>
      </div>
      {showModal && <ConnectionModal onSave={onSaveConn} onCancel={() => setShowModal(false)} />}
    </div>
  );
}
