import { useEffect, useMemo, useRef, useState } from "react";
import { Logo } from "../components/Logo";
import { Chip } from "../components/Chip";
import { SkeletonBlock } from "../components/Skeleton";
import { dragRegionProps } from "../lib/window";
import {
  indexContexts,
  partitionContexts,
  rankContexts,
} from "../lib/contextSearch";
import {
  api,
  errorMessage,
  type ClusterInfo,
  type ContextInfo,
} from "../lib/api";

// The launch screen, and the cluster switcher.
//
// Listing contexts is offline by design (see cluster::list_contexts), so
// this renders even when every cluster in the file is unreachable —
// connecting is where failure becomes visible, and it reports per
// attempt rather than blocking the list.
//
// Sized for a real kubeconfig, which in a large org means thousands of
// contexts written by tooling. Three things follow from that: the search
// text is built once rather than per keystroke, results are *ranked*
// rather than merely filtered, and only the rows on screen are in the
// DOM. Without the last one, first paint means laying out six thousand
// buttons.

/// Row height in pixels, fixed so the list can be windowed without
/// measuring every row. Matches the padding below.
const ROW_HEIGHT = 58;

/// Rows rendered beyond the viewport, so scrolling does not flash blank.
const OVERSCAN = 6;

/// Height of the scrolling area. A fixed height keeps the dialog the
/// same size whether the kubeconfig has three contexts or six thousand.
const LIST_HEIGHT = 348;

/// Below this, everything fits and a filter box is noise.
const FILTER_THRESHOLD = 5;

/// One row of the list, plus the heading that may precede it.
type Row =
  | { kind: "heading"; label: string; key: string }
  | {
      kind: "context";
      context: ContextInfo;
      pinned: boolean;
      /// Already connected this session, so switching to it is instant.
      connected: boolean;
      key: string;
    };

export function ContextPicker({
  current,
  onConnected,
  onCancel,
}: {
  /// Set when switching from a live connection, so the active context
  /// can be marked and the screen can be dismissed.
  current?: ClusterInfo | null;
  onConnected: () => void;
  onCancel?: () => void;
}) {
  const [contexts, setContexts] = useState<ContextInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [recent, setRecent] = useState<string[]>([]);
  const [pinned, setPinned] = useState<string[]>([]);
  /// Contexts already connected this session. Switching to one of these
  /// re-authenticates nothing and re-walks no discovery, so it is worth
  /// saying which they are.
  const [connected, setConnected] = useState<string[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    api
      .listContexts()
      .then(setContexts)
      .catch((e) => {
        setContexts([]);
        setError(errorMessage(e));
      });

    // Recents and pins are the only thing that makes a long list usable.
    // Their absence is not worth an error: the list still works.
    api
      .connectedClusters()
      .then((clusters) => setConnected(clusters.map((c) => c.context)))
      .catch(() => {});

    api
      .getSettings()
      .then((s) => {
        setRecent(s.recentContexts ?? []);
        setPinned(s.pinnedContexts ?? []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!onCancel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  async function connect(name: string) {
    setConnecting(name);
    setError(null);
    try {
      await api.connect(name);
      onConnected();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setConnecting(null);
    }
  }

  async function togglePin(name: string) {
    const next = !pinned.includes(name);
    // Applied first: the click should feel instant, and a pin that fails
    // to persist is still the one the user asked for.
    setPinned((p) => (next ? [...p, name] : p.filter((c) => c !== name)));
    try {
      const settings = await api.setContextPinned(name, next);
      setPinned(settings.pinnedContexts ?? []);
    } catch {
      // Put it back rather than showing a pin the next launch will not
      // have.
      setPinned((p) => (next ? p.filter((c) => c !== name) : [...p, name]));
    }
  }

  // Built once per kubeconfig. This is the line that stops 6,000
  // string concatenations happening on every keystroke.
  const indexed = useMemo(() => indexContexts(contexts ?? []), [contexts]);

  const rows: Row[] = useMemo(() => {
    const ranked = rankContexts(indexed, query);
    const groups = partitionContexts(ranked, pinned, recent);

    const out: Row[] = [];
    const pushGroup = (label: string | null, items: ContextInfo[]) => {
      if (items.length === 0) return;
      if (label) out.push({ kind: "heading", label, key: `heading:${label}` });
      for (const context of items) {
        out.push({
          kind: "context",
          context,
          pinned: pinned.includes(context.name),
          connected: connected.includes(context.name),
          key: `ctx:${context.name}`,
        });
      }
    };

    pushGroup("Pinned", groups.pinned);
    pushGroup("Recent", groups.recent);
    // The remainder is only worth a heading when something sits above it.
    pushGroup(
      groups.pinned.length || groups.recent.length ? "All contexts" : null,
      groups.rest,
    );
    return out;
  }, [indexed, query, pinned, recent, connected]);

  const total = rows.length;
  const visibleRows = Math.ceil(LIST_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2;
  const start = Math.min(
    Math.max(0, total - visibleRows),
    Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN),
  );
  const shown = rows.slice(start, start + visibleRows);

  return (
    <div
      {...dragRegionProps}
      className="ambient drag-region flex h-full items-center justify-center p-8"
    >
      <div className="no-drag w-full max-w-lg animate-slide-up">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo className="mb-3 h-14 w-14" />
          <h1 className="text-xl font-semibold">Loupe</h1>
          <p className="mt-1 text-sm text-content-muted">
            {current
              ? "Switch to another cluster."
              : "Choose a cluster to connect to."}
          </p>
        </div>

        {error && (
          <div className="animate-fade-in mb-4 rounded-sm border border-danger/20 bg-danger/[0.08] px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        {contexts === null ? (
          <div className="space-y-2">
            <SkeletonBlock className="h-14 w-full" />
            <SkeletonBlock className="h-14 w-full" />
            <SkeletonBlock className="h-14 w-full" />
          </div>
        ) : contexts.length === 0 ? (
          <p className="text-center text-sm text-content-muted">
            No contexts found. Loupe reads the same kubeconfig as kubectl — set{" "}
            <code className="font-mono">KUBECONFIG</code> or create{" "}
            <code className="font-mono">~/.kube/config</code>.
          </p>
        ) : (
          <>
            {contexts.length > FILTER_THRESHOLD && (
              <div className="mb-2 flex items-center gap-2">
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    // A new result set starts at the top; keeping the
                    // old offset shows a blank band.
                    setScrollTop(0);
                    if (scrollRef.current) scrollRef.current.scrollTop = 0;
                  }}
                  placeholder="Filter contexts…"
                  aria-label="Filter contexts"
                  className="min-w-0 flex-1 rounded-sm border bg-content/[0.03] px-2.5 py-1.5 text-sm transition-colors duration-150 ease-swift placeholder:text-content-muted focus:border-accent/40"
                />
                <span className="shrink-0 text-2xs tabular-nums text-content-muted">
                  {query
                    ? `${rows.filter((r) => r.kind === "context").length} of ${contexts.length}`
                    : `${contexts.length}`}
                </span>
              </div>
            )}

            <div
              ref={scrollRef}
              onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
              style={{ maxHeight: LIST_HEIGHT }}
              className="glass-overlay overflow-y-auto p-0"
            >
              {total === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-content-muted">
                  Nothing matches “{query}”.
                </p>
              ) : (
                <div style={{ height: total * ROW_HEIGHT }} className="relative">
                  <div
                    style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}
                    className="absolute left-0 top-0 w-full"
                  >
                    {shown.map((row) =>
                      row.kind === "heading" ? (
                        <p
                          key={row.key}
                          style={{ height: ROW_HEIGHT }}
                          className="flex items-end px-4 pb-1 text-2xs font-medium uppercase tracking-wide text-content-muted"
                        >
                          {row.label}
                        </p>
                      ) : (
                        <ContextRow
                          key={row.key}
                          context={row.context}
                          pinned={row.pinned}
                          connected={row.connected}
                          active={current?.context === row.context.name}
                          connecting={connecting}
                          onConnect={connect}
                          onTogglePin={togglePin}
                        />
                      ),
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {onCancel && (
          <button
            onClick={onCancel}
            className="mt-4 w-full text-center text-sm text-content-muted underline-offset-2 transition-colors hover:text-content-secondary hover:underline"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function ContextRow({
  context,
  pinned,
  connected,
  active,
  connecting,
  onConnect,
  onTogglePin,
}: {
  context: ContextInfo;
  pinned: boolean;
  connected: boolean;
  active: boolean;
  connecting: string | null;
  onConnect: (name: string) => void;
  onTogglePin: (name: string) => void;
}) {
  return (
    <div
      style={{ height: ROW_HEIGHT }}
      className="flex items-stretch border-b border-hairline/[0.06]"
    >
      <button
        onClick={() => onConnect(context.name)}
        disabled={connecting !== null}
        className="flex min-w-0 flex-1 items-center justify-between px-4 text-left transition-colors duration-150 ease-swift hover:bg-content/[0.05] disabled:opacity-60"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium">{context.name}</span>
            {active && <Chip tone="ok">connected</Chip>}
            {/* Already connected: the switch will not re-authenticate
                or re-walk discovery, which is the difference between
                instant and several seconds. */}
            {connected && !active && <Chip tone="accent">connected</Chip>}
            {context.isCurrent && !active && !connected && (
              <Chip tone="accent">kubeconfig default</Chip>
            )}
          </span>
          <span className="mt-0.5 block truncate text-2xs text-content-muted">
            {context.cluster}
            {context.namespace ? ` · ${context.namespace}` : ""}
          </span>
        </span>
        <span className="ml-3 shrink-0 text-xs text-content-muted">
          {connecting === context.name ? "Connecting…" : "→"}
        </span>
      </button>

      {/* Separate from the row so pinning and connecting are not the
          same click. */}
      <button
        onClick={() => onTogglePin(context.name)}
        aria-label={pinned ? `Unpin ${context.name}` : `Pin ${context.name}`}
        title={pinned ? "Unpin" : "Pin to the top of the list"}
        className={`shrink-0 px-3 text-xs transition-colors duration-150 ease-swift hover:bg-content/[0.06] ${
          pinned ? "text-accent" : "text-content-muted/40 hover:text-content-secondary"
        }`}
      >
        ★
      </button>
    </div>
  );
}
