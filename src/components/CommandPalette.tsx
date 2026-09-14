import { useEffect, useMemo, useRef, useState } from "react";
import { groupCommands, rankCommands, searchCoverage, type Command } from "../lib/palette";
import { errorMessage, type SearchHit, type SearchResponse } from "../lib/api";
import { intentOf, type OpenIntent } from "../lib/routes";

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

/// How long typing has to pause before the cluster index is asked. The
/// index answers in a millisecond; this is about not sending a round trip
/// per keystroke across the IPC bridge.
const SEARCH_DEBOUNCE_MS = 80;

/// Objects start being searched at this many characters. One matches most
/// of the cluster and tells you nothing.
const SEARCH_MIN = 2;

/// What the palette needs to search the cluster. Optional, so the palette
/// still works — commands only — before a cluster is connected.
export interface ObjectSearch {
  search: (query: string) => Promise<SearchResponse>;
  open: (hit: SearchHit, intent: OpenIntent) => void;
}

export function CommandPalette({
  commands,
  onClose,
  objects,
}: {
  commands: Command[];
  onClose: () => void;
  objects?: ObjectSearch;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [found, setFound] = useState<{ query: string; response: SearchResponse } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  // Bumped to search again for the same text while the index is warming.
  const [retry, setRetry] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Opening the palette starts the index warming, so it has something by
  // the time the first few characters are typed.
  useEffect(() => {
    if (!objects) return;
    // Through a resolved promise, so a search that throws outright is
    // handled the same as one that rejects.
    Promise.resolve()
      .then(() => objects.search(""))
      .then(
      (response) => setFound((f) => f ?? { query: "", response }),
      () => {},
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!objects) return;
    const q = query.trim();
    if (q.length < SEARCH_MIN) return;
    let current = true;
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => objects.search(q))
        .then(
        (response) => {
          // A slower answer to an older query must not replace a newer one.
          if (!current) return;
          setFound({ query: q, response });
          setSearchError(null);
          // Still indexing and nothing yet: ask again shortly, so results
          // appear as kinds finish rather than on the next keystroke.
          if (response.warming) setTimeout(() => current && setRetry((n) => n + 1), 400);
        },
        (e) => current && setSearchError(errorMessage(e)),
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, retry]);

  const objectCommands: Command[] = useMemo(() => {
    const q = query.trim();
    if (!objects || !found || q.length < SEARCH_MIN || found.query !== q) return [];
    return found.response.hits.map((hit) => ({
      id: `object:${hit.group}/${hit.kind}/${hit.namespace ?? ""}/${hit.name}`,
      // Grouped by kind, after the fixed sections, in the order the index
      // ranked them — so the kind holding the best match comes first.
      group: hit.kind,
      label: hit.name,
      hint: [hit.namespace, hit.status].filter(Boolean).join(" · ") || undefined,
      run: (intent: OpenIntent) => objects.open(hit, intent),
    }));
  }, [objects, found, query]);

  const ranked = useMemo(
    () => [...rankCommands(commands, query), ...objectCommands],
    [commands, query, objectCommands],
  );
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
        // ⌘-Enter asks for a tab of its own, the way ⌘-click does.
        chosen.run(intentOf(e));
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
          placeholder={
            objects
              ? "Find any object, go to a kind, run an action…"
              : "Go to a kind, switch cluster, run an action…"
          }
          aria-label="Command"
          className="w-full border-b bg-transparent px-4 py-3 text-sm outline-none placeholder:text-content-muted"
        />

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto">
          {flat.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-content-muted">
              {found?.response.warming && query.trim().length >= SEARCH_MIN
                ? `Nothing yet for “${query}” — still indexing the cluster…`
                : `Nothing matches “${query}”.`}
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
                      onClick={(e) => {
                        onClose();
                        command.run(intentOf(e));
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

        <p className="flex gap-3 border-t px-4 py-1.5 text-2xs text-content-muted">
          <span className="shrink-0">↑↓ move · ↵ open · ⌘↵ new tab · esc close</span>
          {objects && (searchError || found) && (
            <span
              className={`min-w-0 flex-1 truncate text-right ${searchError ? "text-danger" : ""}`}
              role="status"
            >
              {searchError ?? (found ? searchCoverage(found.response) : "")}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}
