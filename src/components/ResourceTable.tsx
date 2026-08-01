import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Table, type Column } from "./Table";
import { SkeletonRows } from "./Skeleton";

const PAGE_SIZE = 50;

export interface ResourceTableProps<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T, index: number) => string;
  /// Free-text haystack for a row. Kept explicit rather than
  /// stringifying the object, so search matches what the user can see.
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
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        {toolbar}

        <label className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-content-muted">
            ⌕
          </span>
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder="Search…"
            className="w-full rounded-sm border bg-content/[0.03] py-1 pl-7 pr-2 text-sm transition-colors duration-150 ease-swift placeholder:text-content-muted focus:border-accent/40 focus:bg-content/[0.05]"
          />
        </label>

        {rows && (
          <span className="shrink-0 text-2xs tabular-nums text-content-muted">
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
          <div className="animate-fade-in">
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
          </div>
        )}
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-between border-t px-4 py-1.5 text-2xs">
          <span className="tabular-nums text-content-muted">
            {start + 1}–{Math.min(start + PAGE_SIZE, filtered.length)} of{" "}
            {filtered.length}
          </span>
          <span className="flex items-center gap-1">
            <PageButton
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              ‹
            </PageButton>
            <span className="px-1.5 tabular-nums text-content-muted">
              {page + 1} / {pageCount}
            </span>
            <PageButton
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={page >= pageCount - 1}
            >
              ›
            </PageButton>
          </span>
        </div>
      )}
    </div>
  );
}

function PageButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-sm border px-2 py-0.5 text-content-secondary transition-colors duration-150 ease-swift hover:bg-content/[0.06] hover:text-content disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
