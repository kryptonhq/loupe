import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Channel,
  api,
  errorMessage,
  type ContainerView,
  type LogEvent,
} from "../lib/api";
import { LogBuffer } from "../lib/logBuffer";
import {
  EMPTY_FILTER,
  compileFilter,
  highlightSegments,
  type FilterSpec,
} from "../lib/logFilter";
import { FilterIndex, filterKey } from "../lib/logView";
import { exportBody, exportName, type ExportContext } from "../lib/logExport";
import { Select } from "./Select";

// Lines are capped so a chatty pod cannot grow memory without bound. The
// cap alone was never the hard part: the previous viewer held every line
// in React state and rendered `lines.join("\n")`, so each arriving line
// copied a 5,000-element array and rebuilt a half-megabyte string — the
// cost went *up* with how much output you had already seen.
//
// Three things fix that, and all three are needed:
//
//   - the buffer lives in a ref, so a line arriving is not a render;
//   - arrivals are coalesced onto an animation frame, so render cost is
//     bound by frame rate rather than by line rate;
//   - only the lines on screen are in the DOM, so a full buffer is not a
//     5,000-node document.
//
// The Rust side coalesces too — see cluster::logs — so a pod emitting
// thousands of lines a second is not also thousands of IPC messages.
const MAX_LINES = 5000;

/// Row height in pixels. Fixed and set explicitly rather than left to
/// the stylesheet, because windowing needs to know where line N is
/// without measuring it.
const LINE_HEIGHT = 19;

/// Extra rows rendered above and below the viewport, so a fast scroll
/// does not show a band of blank space before the next frame lands.
const OVERSCAN = 10;

/// Used until the element has been measured, and in environments with no
/// layout at all. Windowing must never render zero rows just because
/// nothing has reported a height yet.
const ASSUMED_VIEWPORT = 640;

/// How close to the bottom still counts as "at the bottom" for the
/// purpose of staying pinned. A couple of rows of slack, so a trackpad
/// nudge does not unpin a followed stream.
const PIN_SLACK = LINE_HEIGHT * 2;

/// Lines of context offered around a match, `grep -C` style. Kept to a
/// short list rather than a free number: the useful answers are "none",
/// "enough to see the stack frame either side", and "a bit more".
const CONTEXT_CHOICES = [0, 2, 5];

/// Colours cycled through per source pod in a merged view.
///
/// Colour rather than only a name prefix, because twelve interleaved
/// streams are scanned rather than read — the eye picks out "this line
/// came from a different replica" long before it parses the name.
const SOURCE_TONES = [
  "text-info",
  "text-success",
  "text-warn",
  "text-accent",
  "text-danger",
];

interface LogViewerProps {
  namespace: string;
  pod: string;
  containers: ContainerView[];
  /// Set to merge every pod matching a label selector into one view,
  /// rather than streaming the single pod named above. A Deployment's
  /// logs *are* the interleaved logs of its replicas, and reading them
  /// one at a time is the slowest way to find the one that differs.
  selector?: string;
  /// What the merged view is of, for the heading — "Deployment api".
  workload?: string;
}

export function LogViewer({
  namespace,
  pod,
  containers,
  selector,
  workload,
}: LogViewerProps) {
  const merged = selector !== undefined;
  const [container, setContainer] = useState(containers[0]?.name ?? "");
  const [follow, setFollow] = useState(true);
  const [timestamps, setTimestamps] = useState(false);
  const [previous, setPrevious] = useState(false);
  const [status, setStatus] = useState<"idle" | "streaming" | "ended">("idle");
  const [error, setError] = useState<string | null>(null);
  /// Transient confirmation of a copy or a save. Distinct from `error`,
  /// which is about the stream.
  const [notice, setNotice] = useState<string | null>(null);

  // Whether the view sticks to the newest line. Distinct from `follow`,
  // which is a property of the stream: scrolling up to read something
  // should stop the view chasing the bottom, not tear down the
  // connection and lose the lines that arrive while you read.
  const [pinned, setPinned] = useState(true);

  /// Pods seen in a merged view, in the order they joined. The index
  /// into this list is what picks each pod's colour, so the colours stay
  /// put as replicas come and go.
  const [pods, setPods] = useState<string[]>([]);
  /// Set when more pods match than are being streamed.
  const [capped, setCapped] = useState<{ streaming: number; matched: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(ASSUMED_VIEWPORT);
  const [scrollTop, setScrollTop] = useState(0);

  // Held in a ref rather than state: the cleanup function must see the
  // current id, and a state update would not have landed by then.
  const streamId = useRef<number | null>(null);

  // The buffer is deliberately not state. `revision` is what tells React
  // something changed; the buffer itself is read during render, which is
  // safe precisely because every mutation is followed by a bump.
  const buffer = useRef(new LogBuffer(MAX_LINES));
  // Sources live in a parallel ring pushed in lockstep, so a line and
  // its pod share an absolute index. Keeping them apart means the filter
  // matches log text rather than accidentally matching pod names, and
  // the tail-drop stays a single rule applied to both.
  const sources = useRef(new LogBuffer(MAX_LINES));
  const pending = useRef<{ text: string; source: string }[]>([]);
  const frame = useRef<number | null>(null);
  const [revision, setRevision] = useState(0);

  // Filtering is display-only: it never re-requests the stream, so
  // narrowing a running log does not interrupt it or lose the lines that
  // arrive while the pattern is being typed.
  const [filter, setFilter] = useState<FilterSpec>(EMPTY_FILTER);
  const [context, setContext] = useState(0);
  const compiled = useMemo(() => compileFilter(filter), [filter]);
  const key = useMemo(() => filterKey(filter), [filter]);
  const index = useRef(new FilterIndex());

  // Set while the component is scrolling the element itself, so its own
  // scroll events are not mistaken for the user scrolling away.
  const selfScrolling = useRef(false);

  const flush = useCallback(() => {
    frame.current = null;
    if (pending.current.length === 0) return;
    for (const line of pending.current) {
      buffer.current.push(line.text);
      sources.current.push(line.source);
    }
    pending.current = [];
    setRevision((r) => r + 1);
  }, []);

  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(flush);
  }, [flush]);

  useEffect(() => {
    if (!container) return;

    let cancelled = false;

    // A new stream is a new pod, container or option set. Anything still
    // queued belongs to the old one and must not land under the new
    // one's heading.
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    pending.current = [];
    buffer.current.clear();
    sources.current.clear();
    // Absolute indices restart with the buffer, so matches recorded
    // against the old stream now name different lines.
    index.current.reset();
    setRevision((r) => r + 1);
    setError(null);
    setStatus("streaming");
    setPinned(true);
    setPods([]);
    setCapped(null);

    const channel = new Channel<LogEvent>();
    channel.onmessage = (event) => {
      if (cancelled) return;
      switch (event.kind) {
        case "lines":
          for (const text of event.texts) {
            pending.current.push({ text, source: event.source ?? "" });
          }
          schedule();
          break;
        case "podStarted":
          setPods((seen) => (seen.includes(event.pod) ? seen : [...seen, event.pod]));
          break;
        case "podEnded":
          // Deliberately not removed from the list: during a rollout the
          // replica that just died is often the one you were reading,
          // and dropping its colour mid-scroll is disorienting.
          break;
        case "capped":
          setCapped(event);
          break;
        case "ended":
          // Flushed rather than scheduled: there will be no further
          // frame to carry the tail of a short stream.
          flush();
          setStatus("ended");
          break;
        case "failed":
          flush();
          setError(event.message);
          setStatus("ended");
          break;
      }
    };

    const started = merged
      ? api.startMergedLogs(
          {
            namespace,
            selector: selector!,
            container: containers.length > 1 ? container : null,
            tailLines: 500,
            timestamps,
          },
          channel,
        )
      : api.startPodLogs(
          {
            namespace,
            pod,
            container,
            follow,
            tailLines: 500,
            timestamps,
            previous,
          },
          channel,
        );

    started
      .then((id) => {
        // The effect may have been torn down while the command was in
        // flight; stop the stream we just started rather than leaking it.
        if (cancelled) {
          void api.stopPodLogs(id);
          return;
        }
        streamId.current = id;
      })
      .catch((e) => {
        if (cancelled) return;
        setError(errorMessage(e));
        setStatus("ended");
      });

    return () => {
      cancelled = true;
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      if (streamId.current !== null) {
        void api.stopPodLogs(streamId.current);
        streamId.current = null;
      }
    };
  }, [
    namespace,
    pod,
    container,
    follow,
    timestamps,
    previous,
    merged,
    selector,
    containers.length,
    flush,
    schedule,
  ]);

  // Track the element's height so the window is sized to what is
  // actually visible. Guarded because jsdom has no ResizeObserver and no
  // layout — there, the assumed viewport stands in.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (el.clientHeight > 0) setViewport(el.clientHeight);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Bringing the match index up to date is keyed on the buffer having
  // changed, the filter having changed, or the context width having
  // changed — nothing else can alter what is on screen.
  const shown = useMemo(() => {
    index.current.sync(buffer.current, compiled, key);
    return index.current.visible(buffer.current, compiled, context);
    // `revision` is the signal that the buffer moved; it is not read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, compiled, key, context]);

  const dropped = buffer.current.dropped;
  const retained = buffer.current.size;
  const firstIndex = buffer.current.firstIndex;
  // `shown` is null when nothing is being filtered, in which case the
  // visible sequence is the buffer itself and needs no index array.
  const total = shown ? shown.length : retained;

  const rows = Math.ceil(viewport / LINE_HEIGHT) + OVERSCAN * 2;
  const maxStart = Math.max(0, total - rows);
  const start = pinned
    ? maxStart
    : Math.min(maxStart, Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN));

  const window: { index: number; text: string; source: string }[] = [];
  for (let p = start; p < Math.min(start + rows, total); p += 1) {
    const absolute = shown ? shown[p] : firstIndex + p;
    const text = buffer.current.get(absolute);
    if (text !== undefined) {
      window.push({
        index: absolute,
        text,
        source: sources.current.get(absolute) ?? "",
      });
    }
  }

  /// The colour a pod's lines carry. Keyed on join order so a replica
  /// keeps its colour for the life of the view.
  const toneFor = (source: string) => {
    const at = pods.indexOf(source);
    return at < 0 ? "text-content-muted" : SOURCE_TONES[at % SOURCE_TONES.length];
  };

  /// How wide to pad the pod column, so lines line up without the
  /// longest name pushing every other line off the right.
  const sourceWidth = Math.min(
    28,
    pods.reduce((widest, name) => Math.max(widest, name.length), 0),
  );

  // Chase the bottom after a flush. Not in the render path: writing
  // scrollTop forces layout, and doing it per line was half the reason
  // the old viewer stuttered.
  useEffect(() => {
    if (!pinned) return;
    const el = scrollRef.current;
    if (!el) return;
    selfScrolling.current = true;
    el.scrollTop = el.scrollHeight;
    // Cleared on the next task: the scroll event this triggers has not
    // been delivered yet.
    const timer = setTimeout(() => {
      selfScrolling.current = false;
    }, 0);
    return () => clearTimeout(timer);
  }, [revision, pinned]);

  /// The lines an export should contain: what is on screen, filter and
  /// all, rather than the whole buffer. "Save what I am looking at" is
  /// the useful action — and the header records the filter, so the file
  /// cannot be mistaken for the pod's complete output.
  function exportable(): { name: string; body: string; lines: number } {
    const indices =
      shown ?? Array.from({ length: retained }, (_, i) => firstIndex + i);
    const lines = indices
      .map((i) => buffer.current.get(i))
      .filter((l): l is string => l !== undefined);

    const ctx: ExportContext = {
      namespace,
      pod,
      container,
      filter,
      context,
      timestamps,
      dropped,
      retained,
      written: lines.length,
      at: new Date(),
    };
    return { name: exportName(ctx), body: exportBody(ctx, lines), lines: lines.length };
  }

  async function copyLog() {
    const { body, lines } = exportable();
    try {
      await navigator.clipboard.writeText(body);
      setNotice(`Copied ${lines} line${lines === 1 ? "" : "s"}.`);
    } catch {
      // Clipboard access can be refused by the webview. Saying so beats
      // a button that silently does nothing.
      setNotice("Could not reach the clipboard.");
    }
  }

  async function saveLog() {
    const { name, body, lines } = exportable();
    try {
      const path = await api.saveText(name, body);
      // Null means the user cancelled, which needs no comment.
      if (path) setNotice(`Saved ${lines} line${lines === 1 ? "" : "s"} to ${path}`);
    } catch (e) {
      setNotice(errorMessage(e));
    }
  }

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    if (selfScrolling.current) return;
    // Re-pin on returning to the bottom, so following resumes without
    // hunting for a control.
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_SLACK;
    setPinned(atBottom);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2 text-xs">
        {containers.length > 1 && (
          <Select value={container} onChange={setContainer} title="Container">
            {containers.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
        )}

        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
          />
          Follow
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={timestamps}
            onChange={(e) => setTimestamps(e.target.checked)}
          />
          Timestamps
        </label>
        <label
          className="flex items-center gap-1.5"
          title="Read the previous container instance — the only way to see why a crashed pod died"
        >
          <input
            type="checkbox"
            checked={previous}
            onChange={(e) => setPrevious(e.target.checked)}
          />
          Previous
        </label>

        <span className="ml-auto flex items-center gap-2 text-2xs text-content-muted">
          {!pinned && status === "streaming" && (
            <button
              onClick={() => setPinned(true)}
              className="rounded-sm border px-1.5 py-0.5 transition-colors hover:bg-content/[0.06] hover:text-content"
              title="Scroll back to the newest line and keep following it"
            >
              ↓ latest
            </button>
          )}
          <span>
            {status === "streaming" && follow
              ? "streaming…"
              : status === "ended"
                ? "ended"
                : ""}
            {dropped > 0 && ` · showing last ${MAX_LINES}`}
          </span>
        </span>
      </div>

      {/* The filter row. Everything here narrows what is displayed; none
          of it touches the stream. */}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs">
        <input
          value={filter.include}
          onChange={(e) => setFilter((f) => ({ ...f, include: e.target.value }))}
          placeholder={filter.regex ? "Filter (regex)…" : "Filter…"}
          aria-label="Filter lines"
          className="min-w-0 flex-1 rounded-sm border bg-content/[0.03] px-2 py-1 transition-colors duration-150 ease-swift placeholder:text-content-muted focus:border-accent/40"
        />
        <input
          value={filter.exclude}
          onChange={(e) => setFilter((f) => ({ ...f, exclude: e.target.value }))}
          placeholder="Exclude…"
          aria-label="Exclude lines"
          title="Hide lines matching this, the way grep -v would"
          className="min-w-0 flex-1 rounded-sm border bg-content/[0.03] px-2 py-1 transition-colors duration-150 ease-swift placeholder:text-content-muted focus:border-accent/40"
        />

        <label
          className="flex shrink-0 items-center gap-1.5 text-2xs text-content-secondary"
          title="Treat both patterns as regular expressions"
        >
          <input
            type="checkbox"
            checked={filter.regex}
            onChange={(e) => setFilter((f) => ({ ...f, regex: e.target.checked }))}
          />
          Regex
        </label>
        <label
          className="flex shrink-0 items-center gap-1.5 text-2xs text-content-secondary"
          title="Match case"
        >
          <input
            type="checkbox"
            checked={filter.caseSensitive}
            onChange={(e) =>
              setFilter((f) => ({ ...f, caseSensitive: e.target.checked }))
            }
          />
          Aa
        </label>

        <Select
          value={String(context)}
          onChange={(v) => setContext(Number(v))}
          title="Lines of context to show either side of a match"
        >
          {CONTEXT_CHOICES.map((n) => (
            <option key={n} value={n}>
              {n === 0 ? "No context" : `±${n} lines`}
            </option>
          ))}
        </Select>

        {compiled.active && (
          <span className="shrink-0 text-2xs tabular-nums text-content-muted">
            {index.current.matchCount} of {retained}
          </span>
        )}

        {/* Both act on what is displayed, so they sit with the filter
            rather than with the stream controls. */}
        <button
          onClick={copyLog}
          disabled={total === 0}
          title="Copy what is on screen, with a header recording where it came from"
          className="shrink-0 rounded-sm border px-1.5 py-0.5 text-2xs text-content-secondary transition-colors duration-150 ease-swift hover:bg-content/[0.06] hover:text-content disabled:opacity-30"
        >
          Copy
        </button>
        <button
          onClick={saveLog}
          disabled={total === 0}
          title="Save what is on screen to a file"
          className="shrink-0 rounded-sm border px-1.5 py-0.5 text-2xs text-content-secondary transition-colors duration-150 ease-swift hover:bg-content/[0.06] hover:text-content disabled:opacity-30"
        >
          Save…
        </button>
      </div>

      {notice && (
        <div className="animate-fade-in flex items-center gap-2 border-b bg-content/[0.03] px-4 py-1.5 text-2xs text-content-secondary">
          <span className="min-w-0 flex-1 truncate">{notice}</span>
          <button
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="shrink-0 text-content-muted transition-colors hover:text-content"
          >
            ×
          </button>
        </div>
      )}

      {merged && (pods.length > 0 || capped) && (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-1.5 text-2xs">
          <span className="shrink-0 text-content-muted">
            {workload ? `${workload} · ` : ""}
            {pods.length} pod{pods.length === 1 ? "" : "s"}
          </span>
          {pods.map((name) => (
            <span key={name} className={`shrink-0 ${toneFor(name)} opacity-90`}>
              {name}
            </span>
          ))}
          {capped && (
            // Said out loud. A merged view quietly missing half the
            // replicas is worse than one that admits it, because the
            // whole point is finding the replica that differs.
            <span className="ml-auto shrink-0 text-warn">
              showing {capped.streaming} of {capped.matched} matching pods
            </span>
          )}
        </div>
      )}

      {compiled.error && (
        <div className="animate-fade-in border-b border-warn/20 bg-warn/[0.08] px-4 py-1.5 text-2xs text-warn">
          {/* Showing everything, not nothing: a regex is invalid for most
              of the time it is being typed, and blanking the view reads
              as a pod that went silent. */}
          Not a valid pattern ({compiled.error}) — showing every line.
        </div>
      )}

      {error && (
        <div className="animate-fade-in border-b border-danger/20 bg-danger/[0.08] px-4 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-testid="log-scroll"
        className="min-h-0 flex-1 overflow-auto bg-[rgb(var(--code-bg))] px-4 py-2 font-mono text-xs text-[rgb(var(--code-fg))]"
      >
        {total === 0 ? (
          <span className="text-content-muted">
            {compiled.active && retained > 0
              ? "No lines match."
              : status === "streaming"
                ? ""
                : "No output."}
          </span>
        ) : (
          // The spacer carries the full height so the scrollbar reflects
          // the whole buffer; only the window inside it is real DOM.
          <div
            style={{ height: total * LINE_HEIGHT }}
            className="relative w-max min-w-full"
          >
            <div
              style={{ transform: `translateY(${start * LINE_HEIGHT}px)` }}
              className="absolute left-0 top-0 w-full"
            >
              {window.map(({ index: absolute, text, source }) => (
                <div
                  key={absolute}
                  data-testid="log-line"
                  style={{ height: LINE_HEIGHT, lineHeight: `${LINE_HEIGHT}px` }}
                  className="whitespace-pre"
                >
                  {/* Twelve interleaved streams are scanned rather than
                      read: the colour says "different replica" long
                      before the eye parses the name. */}
                  {source && (
                    <span
                      data-testid="log-source"
                      className={`${toneFor(source)} opacity-80`}
                    >
                      {source.padEnd(sourceWidth).slice(0, sourceWidth)}{"  "}
                    </span>
                  )}
                  {/* Matches are marked in place rather than merely
                      surviving the filter — with context lines on, the
                      line that matched has to be findable among them. */}
                  {highlightSegments(text, compiled.highlight).map((seg, i) =>
                    seg.match ? (
                      <mark
                        key={i}
                        className="rounded-[2px] bg-warn/30 text-[rgb(var(--code-fg))]"
                      >
                        {seg.text}
                      </mark>
                    ) : (
                      <span key={i}>{seg.text}</span>
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
