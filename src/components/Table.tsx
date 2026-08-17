// The table every resource view renders through.
//
// Generic over the row type so each view declares its own columns
// without casting. The header is sticky because these lists run to
// hundreds of rows and losing the column names on scroll is the single
// most annoying thing a resource table can do.
import type { ReactNode } from "react";
import { intentOf, type OpenIntent } from "../lib/routes";
import type { SortState, SortValue } from "../lib/sort";

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /// Tabular numerals and monospace for values read by shape — ages,
  /// ready counts, restart counts.
  mono?: boolean;
  /// Keeps a column from being squeezed by a long neighbour.
  width?: string;
  /// What this column sorts on. A column without one is not sortable:
  /// `render` returns a React node, and sorting by that would order the
  /// table by markup rather than by meaning.
  sortValue?: (row: T) => SortValue;
}

interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  /// Index is supplied because not every row set has a natural key —
  /// repeated Kubernetes events can be identical in every field.
  rowKey: (row: T, index: number) => string;
  empty?: string;
  /// The intent says whether the click asked for this tab or a new one.
  onRowClick?: (row: T, intent: OpenIntent) => void;
  /// Which column the rows arrived sorted by, and how. Null means the
  /// order the server sent. Omitting `onSort` leaves every header inert,
  /// which is what the small fixed tables inside a detail view want.
  sort?: SortState | null;
  onSort?: (key: string) => void;
}

/// How the active column's arrow reads. Both directions get a glyph
/// rather than only one, so the header says which way it is sorted
/// instead of only that it is.
const ARROW: Record<"asc" | "desc", string> = { asc: "↑", desc: "↓" };

export function Table<T>({
  columns,
  rows,
  rowKey,
  empty,
  onRowClick,
  sort = null,
  onSort,
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
          {columns.map((c) => {
            const sortable = onSort != null && c.sortValue != null;
            const active = sortable && sort?.key === c.key;
            return (
              <th
                key={c.key}
                style={c.width ? { width: c.width } : undefined}
                // Announced so a screen reader gets the same information
                // the arrow gives everyone else.
                aria-sort={
                  active
                    ? sort!.direction === "asc"
                      ? "ascending"
                      : "descending"
                    : sortable
                      ? "none"
                      : undefined
                }
                className="whitespace-nowrap border-b p-0 text-2xs font-medium uppercase tracking-wide text-content-muted"
              >
                {sortable ? (
                  <button
                    onClick={() => onSort(c.key)}
                    // The header is a drag handle's neighbour and a
                    // click target; the title says what the next click
                    // will do rather than what the last one did.
                    title={
                      active && sort!.direction === "asc"
                        ? `Sort by ${c.header}, descending`
                        : active
                          ? `Stop sorting by ${c.header}`
                          : `Sort by ${c.header}`
                    }
                    className={`flex w-full items-center gap-1 px-4 py-2 text-left uppercase tracking-wide transition-colors duration-150 ease-swift hover:bg-content/[0.05] hover:text-content ${
                      active ? "text-content" : ""
                    }`}
                  >
                    {c.header}
                    {/* The slot is held whether or not this column is
                        the sorted one, so turning a sort on does not
                        shove every other header sideways. */}
                    <span
                      aria-hidden
                      className={active ? "text-accent" : "opacity-0"}
                    >
                      {ARROW[active ? sort!.direction : "asc"]}
                    </span>
                  </button>
                ) : (
                  <span className="block px-4 py-2">{c.header}</span>
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr
            key={rowKey(row, index)}
            onClick={onRowClick ? (e) => onRowClick(row, intentOf(e)) : undefined}
            // Rows are only focusable when they do something; a tab stop
            // that goes nowhere is worse than none.
            tabIndex={onRowClick ? 0 : undefined}
            onKeyDown={
              onRowClick
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onRowClick(row, intentOf(e));
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
