import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Table, type Column } from "./Table";
import { SkeletonRows } from "./Skeleton";

const PAGE_SIZE = 50;

export interface ResourceTableProps<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T, index: number) => string;
  /// Free-text haystack for a row. Kept explicit rather than stringifying
  /// the object, so search matches what the user can actually see.
  searchText: (row: T) => string;
  isLoading: boolean;
  empty?: string;
  onRowClick?: (row: T) => void;
  /// Extra controls rendered to the left of the search box.
  toolbar?: ReactNode;
}

export function ResourceTable<T>({
  columns,
  rows,
  rowKey,
  searchText,
  isLoading,
  empty,
  onRowClick,
  toolbar,
}: ResourceTableProps<T>) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    // Every whitespace-separated term must match somewhere in the row,
    // so "kube running" narrows rather than widening as an OR would.
    const terms = q.split(/\s+/);
    return rows.filter((row) => {
      const haystack = searchText(row).toLowerCase();
      return terms.every((t) => haystack.includes(t));
    });
  }, [rows, query, searchText]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  // Filtering can strip away the page the user was on; clamp rather than
  // showing an empty table below a non-empty result count.
  useEffect(() => {
    if (page > pageCount - 1) setPage(0);
  }, [page, pageCount]);

  const start = page * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-2 dark:border-slate-800">
        {toolbar}
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
          placeholder="Search…"
          className="min-w-0 flex-1 rounded border border-slate-300 bg-transparent px-2 py-1 text-sm placeholder:text-slate-400 focus:border-accent focus:outline-none dark:border-slate-700"
        />
        {rows && (
          <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
            {query
              ? `${filtered.length} of ${rows.length}`
              : `${rows.length} item${rows.length === 1 ? "" : "s"}`}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <SkeletonRows columns={Math.min(columns.length, 5)} />
        ) : (
          <Table
            columns={columns}
            rows={visible}
            rowKey={rowKey}
            onRowClick={onRowClick}
            empty={
              query
                ? `Nothing matches “${query}”.`
                : (empty ?? "Nothing to show.")
            }
          />
        )}
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2 text-xs dark:border-slate-800">
          <span className="text-slate-500 dark:text-slate-400">
            {start + 1}–{Math.min(start + PAGE_SIZE, filtered.length)} of{" "}
            {filtered.length}
          </span>
          <span className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40 dark:border-slate-700"
            >
              Previous
            </button>
            <span className="px-2 text-slate-500 dark:text-slate-400">
              {page + 1} / {pageCount}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={page >= pageCount - 1}
              className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40 dark:border-slate-700"
            >
              Next
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
