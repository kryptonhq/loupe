import { useEffect, type ReactNode } from "react";
import { ErrorStrip } from "./Panel";

// The frame every detail page sits in.
//
// Same shape as Panel — glass header, error strip, scrolling body — plus
// a back affordance and a tab bar, because a detail view is always
// several views of one object. Extracted so pods, nodes, namespaces,
// custom resources and Helm releases cannot drift apart in how they
// present themselves.

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
  onClose: () => void;
  /// What the back button returns to, for its tooltip.
  backTo?: string;
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
  backTo,
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
      <header className="drag-region glass border-b px-4 pb-3 pt-10">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="no-drag rounded-sm px-1.5 text-content-muted transition-colors hover:bg-content/[0.06] hover:text-content"
                title={backTo ? `Back to ${backTo}` : "Back"}
                aria-label={backTo ? `Back to ${backTo}` : "Back"}
              >
                ←
              </button>
              <h2 className="truncate font-semibold">{title}</h2>
              {badge}
            </div>
            {subtitle && (
              <p className="truncate pl-8 text-2xs text-content-muted">
                {subtitle}
              </p>
            )}
          </div>

          <div className="no-drag flex shrink-0 items-center gap-2">
            {actions}
            <button
              onClick={onClose}
              className="shrink-0 rounded-sm border px-2 py-1 text-2xs text-content-secondary transition-colors duration-150 ease-swift hover:bg-content/[0.06] hover:text-content"
            >
              Close
            </button>
          </div>
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

      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </section>
  );
}
