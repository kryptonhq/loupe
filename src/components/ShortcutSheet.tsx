import { useEffect } from "react";

// The shortcuts, written down.
//
// A shortcut nobody can find is a shortcut nobody uses. `?` is the
// convention for this and costs nothing to support.

const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: "⌘K / Ctrl-K", what: "Open the command palette" },
  { keys: "↑ ↓", what: "Move through the palette" },
  { keys: "↵", what: "Run the selected command" },
  { keys: "Esc", what: "Close the palette, or go back from a detail view" },
  { keys: "?", what: "Show this list" },
];

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Keyboard shortcuts"
        className="glass-overlay w-full max-w-sm animate-slide-up p-4"
      >
        <h2 className="mb-3 text-sm font-semibold">Keyboard shortcuts</h2>
        <dl className="space-y-1.5">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-baseline gap-3 text-sm">
              <dt className="w-28 shrink-0 font-mono text-2xs text-content-secondary">
                {s.keys}
              </dt>
              <dd className="min-w-0 flex-1 text-content-secondary">{s.what}</dd>
            </div>
          ))}
        </dl>
        <button
          onClick={onClose}
          className="mt-4 w-full rounded-sm border py-1 text-2xs text-content-secondary transition-colors hover:bg-content/[0.06] hover:text-content"
        >
          Close
        </button>
      </div>
    </div>
  );
}
