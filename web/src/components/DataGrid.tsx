import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ColumnMeta } from '../types';
import DBLogic from '../lib/db-logic';
const { formatCell } = DBLogic;

interface Props {
  columns: ColumnMeta[];
  rows: Record<string, unknown>[];
  readonly?: boolean;
  onCellEdit?: (rowIndex: number, colName: string, value: unknown) => void;
}

const ROW_H = 30;

export function DataGrid({ columns, rows, readonly, onCellEdit }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  return (
    <div className="grid-scroll" ref={parentRef}>
      <table className="grid-table">
        <colgroup>
          <col style={{ width: 44 }} />
          {columns.map((c) => (
            <col key={c.name} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="rownum">#</th>
            {columns.map((c) => (
              <th key={c.name} title={c.type}>
                {c.name}
                {c.pk ? ' 🔑' : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            return (
              <tr
                key={vi.key}
                style={{ position: 'absolute', top: 0, transform: `translateY(${vi.start}px)`, height: ROW_H, width: '100%' }}
              >
                <td className="rownum">{vi.index + 1}</td>
                {columns.map((c) => {
                  const f = formatCell(row[c.name]);
                  return (
                    <td
                      key={c.name}
                      className={f.isNull ? 'null' : ''}
                      contentEditable={!readonly}
                      suppressContentEditableWarning
                      onBlur={(e) => {
                        if (!readonly && onCellEdit) onCellEdit(vi.index, c.name, e.currentTarget.textContent);
                      }}
                    >
                      {f.text}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
