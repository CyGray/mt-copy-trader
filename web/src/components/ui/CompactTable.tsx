'use client';

import { type ReactNode, memo, useCallback } from 'react';

interface CompactTableProps<T extends Record<string, ReactNode>> {
  headers: string[];
  rows: T[];
  maxHeight?: string;
  onRowClick?: (row: T, index: number) => void;
  emptyMessage?: string;
}

function CompactTableComponent<T extends Record<string, ReactNode>>({
  headers,
  rows,
  maxHeight = '400px',
  onRowClick,
  emptyMessage = 'No data available',
}: CompactTableProps<T>) {
  const handleRowClick = useCallback(
    (row: T, index: number) => {
      if (onRowClick) {
        onRowClick(row, index);
      }
    },
    [onRowClick]
  );

  const keys = headers.map((h) => h.toLowerCase().replace(/\s+/g, '_'));

  return (
    <div
      className="overflow-hidden rounded-xl border border-marine-navy/10 bg-white shadow-sm"
      style={{ maxHeight }}
    >
      <div className="overflow-auto" style={{ maxHeight }}>
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 z-10 border-b border-marine-navy/10 bg-marine-mist/80 backdrop-blur-sm">
            <tr>
              {headers.map((header, idx) => (
                <th
                  key={idx}
                  className="whitespace-nowrap px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-marine-navy/60"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-marine-navy/5">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={headers.length}
                  className="px-4 py-8 text-center text-sm text-marine-navy/40"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row, rowIdx) => (
                <tr
                  key={rowIdx}
                  onClick={() => handleRowClick(row, rowIdx)}
                  className={`
                    h-10 transition-colors duration-100
                    ${rowIdx % 2 === 0 ? 'bg-white' : 'bg-marine-mist/30'}
                    ${onRowClick ? 'cursor-pointer hover:bg-marine-accent/5' : ''}
                  `}
                >
                  {keys.map((key, colIdx) => (
                    <td
                      key={colIdx}
                      className="whitespace-nowrap px-4 py-2 text-sm text-marine-navy/80"
                    >
                      {row[key] ?? row[headers[colIdx]] ?? '—'}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const CompactTable = memo(CompactTableComponent) as typeof CompactTableComponent;
