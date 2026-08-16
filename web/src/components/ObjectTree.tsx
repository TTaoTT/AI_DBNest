import { useState } from 'react';

interface Props {
  databases: string[];
  tablesByDb: Record<string, string[]>;
  activeTable?: string;
  onSelectTable: (database: string, table: string) => void;
}

export function ObjectTree({ databases, tablesByDb, activeTable, onSelectTable }: Props) {
  const [openDb, setOpenDb] = useState<string | null>(databases[0] ?? null);
  const [openTbl, setOpenTbl] = useState<boolean>(true);

  if (databases.length === 0) return <div className="hint" style={{ padding: 8 }}>尚未连接</div>;

  return (
    <div className="obj-tree">
      {databases.map((db) => (
        <div key={db}>
          <div className="node" onClick={() => setOpenDb(openDb === db ? null : db)}>
            <span className="ico">🗄️</span> {db}
          </div>
          {openDb === db && (
            <div className="children">
              <div className="node" onClick={() => setOpenTbl(!openTbl)}>
                <span className="ico">📁</span> 表 ({tablesByDb[db]?.length ?? 0})
              </div>
              {openTbl &&
                (tablesByDb[db] || []).map((t) => (
                  <div
                    key={t}
                    className={'node tbl' + (activeTable === t ? ' sel' : '')}
                    onClick={() => onSelectTable(db, t)}
                  >
                    <span className="ico">📄</span> {t}
                  </div>
                ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
