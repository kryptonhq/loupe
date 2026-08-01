import type { ReactNode } from "react";
import { RefreshingDot } from "./Skeleton";
import { errorMessage } from "../lib/api";
import { dragRegionProps } from "../lib/window";

// The frame every main-pane view sits in: a glass header that stays put,
// an error strip, and a scrolling body.
//
// The header is a drag region so the whole top edge moves the window,
// which is what a native app does. Controls inside it opt out.

export function Panel({
  title,
  subtitle,
  error,
  isFetching,
  onRefresh,
  actions,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  error?: unknown;
  isFetching?: boolean;
  onRefresh?: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex h-full flex-col">
      <header
        {...dragRegionProps}
        className="drag-region glass flex items-center justify-between gap-3 border-b px-4 pb-3 pt-10"
      >
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold tracking-tight">
            {title}
          </h2>
          {subtitle && (
            <p className="truncate text-2xs text-content-muted">{subtitle}</p>
          )}
        </div>

        <div className="no-drag flex shrink-0 items-center gap-3">
          {/* Shown instead of a skeleton once data exists, so a
              background refetch never blanks the table. */}
          {isFetching && <RefreshingDot />}
          {actions}
          {onRefresh && (
            <button
              onClick={onRefresh}
              className="rounded-sm border px-2 py-1 text-2xs text-content-secondary transition-colors duration-150 ease-swift hover:bg-content/[0.06] hover:text-content"
            >
              Refresh
            </button>
          )}
        </div>
      </header>

      {error != null && <ErrorStrip error={error} />}

      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

export function ErrorStrip({ error }: { error: unknown }) {
  return (
    <div
      role="alert"
      className="animate-fade-in border-b border-danger/20 bg-danger/[0.08] px-4 py-2 text-xs text-danger"
    >
      {errorMessage(error)}
    </div>
  );
}
