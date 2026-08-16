import type { ConnectionRecord } from '../types';

interface Props {
  connections: ConnectionRecord[];
  activeId?: string;
  onSelect: (c: ConnectionRecord) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}

export function ConnectionManager({ connections, activeId, onSelect, onDelete, onNew }: Props) {
  return (
    <div className="conn-list">
      <button className="btn primary full" onClick={onNew}>
        + 新建连接
      </button>
      {connections.length === 0 && <div className="hint" style={{ padding: 8 }}>还没有连接</div>}
      {connections.map((c) => (
        <div
          key={c.id}
          className={'conn-item' + (c.id === activeId ? ' sel' : '')}
          onClick={() => onSelect(c)}
        >
          <span className="conn-name">🔌 {c.name || c.type}</span>
          {c.readonly && <span className="badge read">RO</span>}
          <button
            className="x"
            title="删除"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(c.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
