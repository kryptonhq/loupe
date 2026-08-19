import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Table, type Column } from "./Table";
import { SkeletonRows } from "./Skeleton";
import type { ListView, OpenIntent } from "../lib/routes";
import { nextSort, sortRows, type SortState } from "../lib/sort";

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
  onRowClick?: (row: T, intent: OpenIntent) => void;
  /// Extra controls rendered to the left of the search box.
  toolbar?: ReactNode;
  /// True when the cluster holds more objects than have been fetched.
  /// Everything below is about saying that plainly: a search across a
  /// partly loaded listing has not searched the cluster, and a table
  /// that implies otherwise is quietly lying about its results.
  hasMore?: boolean;
  /// How many objects the server says are still to come, when it says.
  remaining?: number | null;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /// The search text and sort, when the caller wants them to outlive
  /// this component. A listing does: it unmounts the moment you open a
  /// row, and a filter that evaporates on the way to a pod and back is
  /// the filter you have to retype every time.
  ///
  /// Omitted by the small fixed tables inside a detail view, which are
  /// gone for good when you leave and have nothing worth keeping. They
  /// fall back to holding it themselves.
  view?: ListView;
  onView?: (patch: Partial<ListView>) => void;
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
  hasMore = false,
  remaining = null,
  loadingMore = false,
  onLoadMore,
  view,
  onView,
}: ResourceTableProps<T>) {
  const [page, setPage] = useState(0);

  // Held by the caller when it offered somewhere to hold it, and here
  // otherwise. Null sort is the order the server sent, which for a
  // Kubernetes listing is meaningful in its own right — it is what
  // `kubectl get` prints.
  const [ownQuery, setOwnQuery] = useState("");
  const [ownSort, setOwnSort] = useState<SortState | null>(null);

  const kept = onView != null;
  const query = kept ? (view?.query ?? "") : ownQuery;
  const sort = kept ? (view?.sort ?? null) : ownSort;
  const setQuery = (next: string) =>
    kept ? onView({ query: next }) : setOwnQuery(next);
  const setSort = (next: SortState | null) =>
    kept ? onView({ sort: next }) : setOwnSort(next);

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

  // After filtering and before paging, so page 1 holds the first rows of
  // the sorted set rather than the sorted first page.
  const ordered = useMemo(() => {
    if (!sort) return filtered;
    const column = columns.find((c) => c.key === sort.key);
    if (!column?.sortValue) return filtered;
    return sortRows(filtered, column.sortValue, sort.direction);
  }, [filtered, sort, columns]);

  function chooseSort(key: string) {
    setSort(nextSort(sort, key));
    // The row that was on page 3 is somewhere else entirely now.
    setPage(0);
  }

  const pageCount = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));

  // Filtering can strip away the page the user was on; clamp rather than
  // showing an empty table below a non-empty result count.
  useEffect(() => {
    if (page > pageCount - 1) setPage(0);
  }, [page, pageCount]);

  const start = page * PAGE_SIZE;
  const visible = ordered.slice(start, start + PAGE_SIZE);

  // A sort over a partly loaded listing has not sorted the cluster, in
  // exactly the way a search over one has not searched it — and a sort
  // hides that better, because the rows come back convincingly ordered
  // with the real top of the list still on the server.
  const partial =
    query && sort
      ? "search and sort cover"
      : query
        ? "search covers"
        : sort
          ? "the sort covers"
          : null;

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
          <span
            className="shrink-0 text-2xs tabular-nums text-content-muted"
            title={
              hasMore
                ? "More objects exist in the cluster than have been loaded, so searching and sorting cover only what is here"
                : undefined
            }
          >
            {query
              ? `${filtered.length} of ${rows.length}`
              : `${rows.length} item${rows.length === 1 ? "" : "s"}`}
            {hasMore && (
              <span className="text-warn">
                {" "}
                loaded
                {remaining !== null && ` · ${remaining} more`}
              </span>
            )}
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
              sort={sort}
              onSort={chooseSort}
              empty={
                query
                  ? `Nothing matches “${query}”.`
                  : (empty ?? "Nothing to show.")
              }
            />
          </div>
        )}
      </div>

      {hasMore && (
        <div className="flex items-center justify-between gap-3 border-t bg-warn/[0.04] px-4 py-1.5 text-2xs">
          <span className="min-w-0 truncate text-content-secondary">
            Showing the first {rows?.length ?? 0}
            {remaining !== null && ` of ${(rows?.length ?? 0) + remaining}`}
            {partial && ` — ${partial} only what is loaded`}
          </span>
          <button
            onClick={onLoadMore}
            disabled={loadingMore}
            className="shrink-0 rounded-sm border px-2 py-0.5 text-content-secondary transition-colors duration-150 ease-swift hover:bg-content/[0.06] hover:text-content disabled:opacity-40"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}

      {pageCount > 1 && (
        <div className="flex items-center justify-between border-t px-4 py-1.5 text-2xs">
          <span className="tabular-nums text-content-muted">
            {start + 1}–{Math.min(start + PAGE_SIZE, ordered.length)} of{" "}
            {ordered.length}
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
