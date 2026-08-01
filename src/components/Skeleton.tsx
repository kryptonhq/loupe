// Loading placeholders.
//
// These render only on a *cold* load — when there is no cached data to
// show. Once a resource has been fetched once, refetches keep the old
// rows on screen and show a subtler indicator instead, because replacing
// a populated table with grey bars every few seconds is worse than a
// slightly stale number.

export function SkeletonRows({
  rows = 8,
  columns = 4,
}: {
  rows?: number;
  columns?: number;
}) {
  // Varied widths so the placeholder reads as text rather than a grid.
  const widths = ["w-40", "w-24", "w-32", "w-20", "w-28", "w-16", "w-36"];

  return (
    <div className="animate-pulse" aria-hidden="true">
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="flex gap-6 border-b border-slate-100 px-4 py-3 last:border-0 dark:border-slate-900"
        >
          {Array.from({ length: columns }).map((_, c) => (
            <div
              key={c}
              className={`h-3 rounded bg-slate-200 dark:bg-slate-800 ${widths[(r + c) % widths.length]}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonBlock({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded bg-slate-200 dark:bg-slate-800 ${className}`}
    />
  );
}

/// A quiet indicator for a refetch that is happening behind data the
/// user can already see.
export function RefreshingDot() {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
      refreshing
    </span>
  );
}
