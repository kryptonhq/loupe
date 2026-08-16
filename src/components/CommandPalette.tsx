import { useEffect, useMemo, useRef, useState } from "react";
import { groupCommands, rankCommands, type Command } from "../lib/palette";

// Keyboard-first navigation.
//
// The complaint behind this is "why would I use a GUI over k9s". People
// who live in a terminal are not attached to text rendering — they are
// attached to not moving their hands, and a GUI that needs the mouse for
// every navigation is slower for them however it looks. The palette is
// the answer, and it is deliberately platform-conventional rather than a
// half-imitation of vim bindings, which would serve neither audience.

/// Section order. Fixed, so the palette's structure does not rearrange
/// itself while you type.
export const GROUP_ORDER = ["Go to", "Cluster", "Action"];

export function CommandPalette({
  commands,
  onClose,
}: {
  commands: Command[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const ranked = useMemo(() => rankCommands(commands, query), [commands, query]);
  const groups = useMemo(() => groupCommands(ranked, GROUP_ORDER), [ranked]);
  // The flat order the arrow keys walk, which is the order on screen
  // rather than the ranked order — they differ once grouping applies.
  const flat = useMemo(() => groups.flatMap((g) => g.commands), [groups]);

  // A new result set invalidates the old selection; leaving it where it
  // was means Enter runs whatever happens to be at that index now.
  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    // Guarded: keeping the selection visible is a nicety, and an
    // environment without scrollIntoView must not take the palette down
    // with it.
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setActive((a) => Math.min(flat.length - 1, a + 1));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = flat[active];
      if (chosen) {
        // Closed first: running a command usually changes the view
        // underneath, and a palette left open over it looks stuck.
        onClose();
        chosen.run();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]"
      // Clicking away is the other way out, and the one people try first.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Command palette"
        className="glass-overlay w-full max-w-xl overflow-hidden animate-slide-up"
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Go to a kind, switch cluster, run an action…"
          aria-label="Command"
          className="w-full border-b bg-transparent px-4 py-3 text-sm outline-none placeholder:text-content-muted"
        />

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto">
          {flat.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-content-muted">
              Nothing matches “{query}”.
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.group}>
                <p className="px-4 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-content-muted">
                  {group.group}
                </p>
                {group.commands.map((command) => {
                  const index = flat.indexOf(command);
                  const selected = index === active;
                  return (
                    <button
                      key={command.id}
                      data-active={selected}
                      // Hovering moves the selection, so the mouse and
                      // the keyboard never disagree about what Enter does.
                      onMouseMove={() => setActive(index)}
                      onClick={() => {
                        onClose();
                        command.run();
                      }}
                      className={`flex w-full items-center gap-3 px-4 py-1.5 text-left text-sm transition-colors ${
                        selected ? "bg-accent/[0.14] text-content" : "text-content-secondary"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{command.label}</span>
                      {command.hint && (
                        <span className="shrink-0 truncate text-2xs text-content-muted">
                          {command.hint}
                        </span>
                      )}
                    </button>
                  );
                })}
              </section>
            ))
          )}
        </div>

        <p className="border-t px-4 py-1.5 text-2xs text-content-muted">
          ↑↓ to move · ↵ to run · esc to close · ? for shortcuts
        </p>
      </div>
    </div>
  );
}
