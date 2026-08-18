import { useEffect, type ReactNode } from "react";
import { ErrorStrip } from "./Panel";
import { dragRegionProps } from "../lib/window";

// The frame every detail page sits in.
//
// Same shape as Panel — glass header, error strip, scrolling body — plus
// a tab bar, because a detail view is always several views of one
// object. Extracted so pods, nodes, namespaces, custom resources and
// Helm releases cannot drift apart in how they present themselves.
//
// Going back is not this component's job any more: the trail bar above
// owns it, for every route rather than only for detail views. What is
// left here is Escape, which stays because a reader's hand is already
// on the keyboard and it is the one binding people try without being
// told.

export interface TabSpec {
  id: string;
  label: string;
}

interface DetailShellProps {
  title: string;
  subtitle?: ReactNode;
  /// Rendered beside the title — a status dot, usually.
  badge?: ReactNode;
  tabs: TabSpec[];
  tab: string;
  onTab: (id: string) => void;
  /// Escape. Wired to the trail bar's back, so the key and the arrow
  /// do the same thing.
  onClose: () => void;
  error?: unknown;
  actions?: ReactNode;
  children: ReactNode;
}

export function DetailShell({
  title,
  subtitle,
  badge,
  tabs,
  tab,
  onTab,
  onClose,
  error,
  actions,
  children,
}: DetailShellProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignored while typing: Escape in the YAML editor should not throw
      // away an edit in progress by closing the page underneath it.
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "TEXTAREA" || target?.tagName === "INPUT") return;
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <section className="flex h-full flex-col">
      <header {...dragRegionProps} className="drag-region glass border-b px-4 pb-3 pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate font-semibold">{title}</h2>
              {badge}
            </div>
            {subtitle && (
              <p className="truncate text-2xs text-content-muted">{subtitle}</p>
            )}
          </div>

          <div className="no-drag flex shrink-0 items-center gap-2">{actions}</div>
        </div>

        <nav className="no-drag mt-3 flex gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => onTab(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
              className={`rounded px-2.5 py-1 text-sm transition-colors ${
                tab === t.id
                  ? "bg-accent/[0.14] font-medium text-content"
                  : "text-content-secondary hover:bg-content/[0.05] hover:text-content"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {error != null && <ErrorStrip error={error} />}

      {/* The content plane, same as Panel's — a detail view and a
          listing are the same kind of surface and must not differ. */}
      <div className="min-h-0 flex-1 overflow-hidden bg-surface-1">
        {children}
      </div>
    </section>
  );
}
