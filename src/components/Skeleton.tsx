// Loading placeholders.
//
// These render only on a *cold* load — when there is no cached data to
// show. Once a resource has been fetched, refetches keep the old rows on
// screen and show the quieter indicator below instead, because replacing
// a populated table with grey bars every few seconds is worse than a
// slightly stale number.
//
// The shimmer is a moving highlight rather than a pulsing opacity. A
// pulse on a large block reads as the whole panel flashing; a sweep
// reads as "working", which is what it means.

function Bar({ className = "" }: { className?: string }) {
  return (
    <div
      className={`relative overflow-hidden rounded-sm bg-content/[0.06] ${className}`}
    >
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-content/[0.06] to-transparent" />
    </div>
  );
}

export function SkeletonRows({
  rows = 10,
  columns = 4,
}: {
  rows?: number;
  columns?: number;
}) {
  // Varied widths so the placeholder reads as text rather than a grid.
  const widths = ["w-40", "w-24", "w-32", "w-20", "w-28", "w-16", "w-36"];

  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="flex gap-6 border-b border-hairline/[0.05] px-4 py-[0.6875rem] last:border-0"
        >
          {Array.from({ length: columns }).map((_, c) => (
            <Bar
              key={c}
              className={`h-3 ${widths[(r + c) % widths.length]}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonBlock({ className = "" }: { className?: string }) {
  return <Bar className={className} />;
}

/// A quiet indicator for a refetch happening behind data the user can
/// already see.
export function RefreshingDot() {
  return (
    <span className="inline-flex items-center gap-1.5 text-2xs text-content-muted">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
      </span>
      refreshing
    </span>
  );
}
