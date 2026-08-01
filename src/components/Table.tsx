// The table every resource view renders through.
//
// Generic over the row type so each view declares its own columns
// without casting. The header is sticky because these lists run to
// hundreds of rows and losing the column names on scroll is the single
// most annoying thing a resource table can do.
import type { ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /// Tabular numerals and monospace for values read by shape — ages,
  /// ready counts, restart counts.
  mono?: boolean;
  /// Keeps a column from being squeezed by a long neighbour.
  width?: string;
}

interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  /// Index is supplied because not every row set has a natural key —
  /// repeated Kubernetes events can be identical in every field.
  rowKey: (row: T, index: number) => string;
  empty?: string;
  onRowClick?: (row: T) => void;
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  empty,
  onRowClick,
}: TableProps<T>) {
  if (rows.length === 0) {
    return (
      <p className="px-4 py-12 text-center text-sm text-content-muted">
        {empty ?? "Nothing to show."}
      </p>
    );
  }

  return (
    <table className="w-full border-collapse text-sm">
      <thead className="sticky top-0 z-10">
        <tr className="glass text-left">
          {columns.map((c) => (
            <th
              key={c.key}
              style={c.width ? { width: c.width } : undefined}
              className="whitespace-nowrap border-b px-4 py-2 text-2xs font-medium uppercase tracking-wide text-content-muted"
            >
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr
            key={rowKey(row, index)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            // Rows are only focusable when they do something; a tab stop
            // that goes nowhere is worse than none.
            tabIndex={onRowClick ? 0 : undefined}
            onKeyDown={
              onRowClick
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onRowClick(row);
                    }
                  }
                : undefined
            }
            className={`row-hover border-b border-hairline/[0.05] last:border-0 ${
              onRowClick ? "cursor-pointer" : ""
            }`}
          >
            {columns.map((c) => (
              <td
                key={c.key}
                className={`px-4 py-2 ${
                  c.mono
                    ? "font-mono tabular-nums text-content-secondary"
                    : ""
                }`}
              >
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
