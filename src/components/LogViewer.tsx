import { useCallback, useEffect, useRef, useState } from "react";
import {
  Channel,
  api,
  errorMessage,
  type ContainerView,
  type LogEvent,
} from "../lib/api";
import { LogBuffer } from "../lib/logBuffer";
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

interface LogViewerProps {
  namespace: string;
  pod: string;
  containers: ContainerView[];
}

export function LogViewer({ namespace, pod, containers }: LogViewerProps) {
  const [container, setContainer] = useState(containers[0]?.name ?? "");
  const [follow, setFollow] = useState(true);
  const [timestamps, setTimestamps] = useState(false);
  const [previous, setPrevious] = useState(false);
  const [status, setStatus] = useState<"idle" | "streaming" | "ended">("idle");
  const [error, setError] = useState<string | null>(null);

  // Whether the view sticks to the newest line. Distinct from `follow`,
  // which is a property of the stream: scrolling up to read something
  // should stop the view chasing the bottom, not tear down the
  // connection and lose the lines that arrive while you read.
  const [pinned, setPinned] = useState(true);

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
  const pending = useRef<string[]>([]);
  const frame = useRef<number | null>(null);
  const [revision, setRevision] = useState(0);

  // Set while the component is scrolling the element itself, so its own
  // scroll events are not mistaken for the user scrolling away.
  const selfScrolling = useRef(false);

  const flush = useCallback(() => {
    frame.current = null;
    if (pending.current.length === 0) return;
    for (const line of pending.current) buffer.current.push(line);
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
    setRevision((r) => r + 1);
    setError(null);
    setStatus("streaming");
    setPinned(true);

    const channel = new Channel<LogEvent>();
    channel.onmessage = (event) => {
      if (cancelled) return;
      switch (event.kind) {
        case "lines":
          pending.current.push(...event.texts);
          schedule();
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

    api
      .startPodLogs(
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
      )
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
  }, [namespace, pod, container, follow, timestamps, previous, flush, schedule]);

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

  const total = buffer.current.size;
  const dropped = buffer.current.dropped;

  const rows = Math.ceil(viewport / LINE_HEIGHT) + OVERSCAN * 2;
  const maxStart = Math.max(0, total - rows);
  const start = pinned
    ? maxStart
    : Math.min(maxStart, Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN));

  const firstIndex = buffer.current.firstIndex;
  const visible = buffer.current.slice(
    firstIndex + start,
    firstIndex + start + rows,
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
            {status === "streaming" ? "" : "No output."}
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
              {visible.map((text, i) => (
                <div
                  key={firstIndex + start + i}
                  data-testid="log-line"
                  style={{ height: LINE_HEIGHT, lineHeight: `${LINE_HEIGHT}px` }}
                  className="whitespace-pre"
                >
                  {text}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
