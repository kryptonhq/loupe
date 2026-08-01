import { useEffect, useRef, useState } from "react";
import {
  Channel,
  api,
  errorMessage,
  type ContainerView,
  type LogEvent,
} from "../lib/api";

// Lines are capped so a chatty pod cannot grow the DOM without bound.
// At 5k lines the viewer stays responsive; beyond that the browser
// starts to stutter long before anyone scrolls back that far.
const MAX_LINES = 5000;

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
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "streaming" | "ended">("idle");
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLPreElement>(null);
  // Held in a ref rather than state: the cleanup function must see the
  // current id, and a state update would not have landed by then.
  const streamId = useRef<number | null>(null);

  useEffect(() => {
    if (!container) return;

    let cancelled = false;
    setLines([]);
    setError(null);
    setStatus("streaming");

    const channel = new Channel<LogEvent>();
    channel.onmessage = (event) => {
      if (cancelled) return;
      switch (event.kind) {
        case "line":
          setLines((prev) => {
            const next = prev.length >= MAX_LINES ? prev.slice(1) : prev.slice();
            next.push(event.text);
            return next;
          });
          break;
        case "ended":
          setStatus("ended");
          break;
        case "failed":
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
      if (streamId.current !== null) {
        void api.stopPodLogs(streamId.current);
        streamId.current = null;
      }
    };
  }, [namespace, pod, container, follow, timestamps, previous]);

  useEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-2 text-sm dark:border-slate-800">
        {containers.length > 1 && (
          <select
            value={container}
            onChange={(e) => setContainer(e.target.value)}
            className="rounded border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-700"
          >
            {containers.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
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

        <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
          {status === "streaming" && follow
            ? "streaming…"
            : status === "ended"
              ? "ended"
              : ""}
          {lines.length >= MAX_LINES && ` · showing last ${MAX_LINES}`}
        </span>
      </div>

      {error && (
        <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">
          {error}
        </div>
      )}

      <pre
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto bg-slate-950 px-4 py-2 font-mono text-xs leading-relaxed text-slate-200"
      >
        {lines.length === 0 && status !== "streaming"
          ? "No output."
          : lines.join("\n")}
      </pre>
    </div>
  );
}
