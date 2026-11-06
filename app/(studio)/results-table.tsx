'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';

import type { Column } from './api';

/**
 * Rows as a table, paged in the browser.
 *
 * Values arrive already in their JSON form (bytes as 0x-hex, bigints as
 * decimal strings), so formatting here is presentation only: numbers right
 * aligned, long hex clipped with the full value on hover, nulls marked.
 */

const PAGE = 100;
const NUMERIC = new Set(['integer', 'bigint', 'float', 'numeric']);

function display(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value as string | number | boolean);
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = display(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function downloadCsv(
  columns: Column[],
  rows: unknown[][],
  name: string,
) {
  const lines = [
    columns.map((column) => csvCell(column.name)).join(','),
    ...rows.map((row) => row.map(csvCell).join(',')),
  ];
  const blob = new Blob([`${lines.join('\n')}\n`], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function ResultsTable({
  columns,
  rows,
  name,
  footer,
}: {
  columns: Column[];
  rows: unknown[][];
  /** File name for the CSV download. */
  name: string;
  footer?: React.ReactNode;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const current = Math.min(page, pages - 1);
  const visible = rows.slice(current * PAGE, (current + 1) * PAGE);

  if (!columns.length) {
    return <p className="studio-muted results-empty">No columns.</p>;
  }

  return (
    <div className="results">
      <div className="results-scroll">
        <table className="results-table">
          <thead>
            <tr>
              <th scope="col" className="results-index">
                #
              </th>
              {columns.map((column, index) => (
                <th
                  key={index}
                  scope="col"
                  className={NUMERIC.has(column.type) ? 'numeric' : undefined}
                >
                  <span>{column.name}</span>
                  <small>{column.type}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, rowIndex) => (
              <tr key={current * PAGE + rowIndex}>
                <td className="results-index">
                  {current * PAGE + rowIndex + 1}
                </td>
                {columns.map((column, index) => {
                  const value = row[index];
                  const text = display(value);
                  return (
                    <td
                      key={index}
                      className={[
                        NUMERIC.has(column.type) ? 'numeric' : '',
                        column.type === 'bytes' ? 'mono' : '',
                        value === null ? 'null' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      title={text.length > 24 ? text : undefined}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="studio-muted results-empty">No rows.</p>}
      </div>
      <div className="results-footer">
        <span className="studio-muted">
          {rows.length.toLocaleString()} row{rows.length === 1 ? '' : 's'}
        </span>
        {footer}
        <span className="results-spacer" />
        {pages > 1 && (
          <span className="results-pager">
            <button
              type="button"
              className="studio-icon-button"
              aria-label="Previous page"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
            <span>
              {current + 1} / {pages}
            </span>
            <button
              type="button"
              className="studio-icon-button"
              aria-label="Next page"
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </span>
        )}
        <button
          type="button"
          className="studio-button"
          disabled={!rows.length}
          onClick={() => downloadCsv(columns, rows, name)}
        >
          <Download size={13} aria-hidden="true" /> CSV
        </button>
      </div>
    </div>
  );
}
