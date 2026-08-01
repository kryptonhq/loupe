// A minimal table used by every resource view.
//
// Generic over the row type so each view declares its own columns
// without casting. Kept deliberately plain: resource views differ in
// their columns, not in their chrome, and a shared component keeps the
// spacing and zebra rules in one place.
import type { ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /// Tabular numerals and monospace for values read by shape — ages,
  /// ready counts, restart counts.
  mono?: boolean;
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
      <p className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
        {empty ?? "Nothing to show."}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left dark:border-slate-800">
            {columns.map((c) => (
              <th
                key={c.key}
                className="px-4 py-2 font-medium text-slate-500 dark:text-slate-400"
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
              // Rows are only focusable when they actually do something;
              // a tab stop that does nothing is worse than none.
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
              className={`border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-900 dark:hover:bg-slate-900/50 ${
                onRowClick ? "cursor-pointer" : ""
              }`}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`px-4 py-2 ${c.mono ? "font-mono tabular-nums text-slate-600 dark:text-slate-400" : ""}`}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
