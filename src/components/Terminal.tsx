import { useCallback, useEffect, useRef, useState } from "react";
import {
  Channel,
  api,
  errorMessage,
  type ContainerView,
  type ExecEvent,
} from "../lib/api";
import { Select } from "./Select";
import { useCluster } from "../lib/clusterContext";

// A shell in a container.
//
// Deliberately a small terminal rather than a full emulator. Loupe does
// not bundle xterm.js: it is a large dependency whose value is ANSI
// rendering, and the honest position is that this is a place to run
// `ls`, `cat` and `curl` — not to run vim. So escape sequences are
// stripped rather than interpreted, and the view says as much, which is
// better than rendering them as mojibake and pretending.
//
// Everything the user types goes straight to the remote shell. Output
// arrives on a channel; the webview never holds the connection.

/// Approximate character cell size, used to tell the remote TTY how big
/// the window is. Full-screen programs otherwise draw for 80x24 whatever
/// the window says.
const CELL_WIDTH = 7.2;
const CELL_HEIGHT = 19;

/// Output kept. A terminal is not a log viewer: this bounds memory on a
/// command that prints forever, and nothing more.
const MAX_OUTPUT = 200_000;

/// Strips ANSI escape sequences.
///
/// Not interpreted: colouring output properly means an emulator, and an
/// emulator is a much bigger thing than this view is trying to be.
/// Leaving them in renders as visible gibberish, which is worse than
/// plain text.
export function stripAnsi(text: string): string {
  return (
    text
      // CSI sequences: colours, cursor movement, erase.
      .replace(/\[[0-9;?]*[ -/]*[@-~]/g, "")
      // OSC sequences, which carry window titles and end with BEL or ST.
      .replace(/\][^]*(?:|\\)/g, "")
      // Lone escapes and the shift-out/shift-in pair some shells emit.
      .replace(/[()][A-Za-z0-9]/g, "")
      .replace(/[]/g, "")
      // Carriage returns without a newline are a progress bar redrawing
      // in place; without an emulator the least-wrong thing is a break.
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
  );
}

export function Terminal({
  namespace,
  pod,
  containers,
}: {
  namespace: string;
  pod: string;
  containers: ContainerView[];
}) {
  const { guard } = useCluster();
  const [container, setContainer] = useState(containers[0]?.name ?? "");
  const [output, setOutput] = useState("");
  const [shell, setShell] = useState<string | null>(null);
  const [status, setStatus] = useState<"opening" | "open" | "closed">("opening");
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");

  const sessionId = useRef<number | null>(null);
  const viewRef = useRef<HTMLPreElement>(null);

  // A shell is a write whatever it is used for, so a context marked
  // read-only does not hand one out. The backend refuses too; this is
  // so the user is told why rather than shown a terminal that fails.
  const blocked = guard === "readOnly";

  useEffect(() => {
    if (!container || blocked) return;
    let cancelled = false;

    setOutput("");
    setError(null);
    setShell(null);
    setStatus("opening");

    const channel = new Channel<ExecEvent>();
    channel.onmessage = (event) => {
      if (cancelled) return;
      switch (event.kind) {
        case "started":
          setShell(event.shell);
          setStatus("open");
          break;
        case "output":
          setOutput((prev) => {
            const next = prev + stripAnsi(event.data);
            // Trimmed from the front: the end is what anyone is reading.
            return next.length > MAX_OUTPUT ? next.slice(-MAX_OUTPUT) : next;
          });
          break;
        case "ended":
          setStatus("closed");
          break;
        case "failed":
          setError(event.message);
          setStatus("closed");
          break;
      }
    };

    api
      .startExec({ namespace, pod, container, shell: null }, channel)
      .then((id) => {
        if (cancelled) {
          // The tab closed while the shell was opening; close it rather
          // than leaving a process running in somebody's container.
          void api.closeExec(id);
          return;
        }
        sessionId.current = id;
      })
      .catch((e) => {
        if (cancelled) return;
        setError(errorMessage(e));
        setStatus("closed");
      });

    return () => {
      cancelled = true;
      if (sessionId.current !== null) {
        void api.closeExec(sessionId.current);
        sessionId.current = null;
      }
    };
  }, [namespace, pod, container, blocked]);

  // Keep the remote TTY's idea of the window in step with the real one.
  const reportSize = useCallback(() => {
    const el = viewRef.current;
    const id = sessionId.current;
    if (!el || id === null) return;
    const width = Math.max(20, Math.floor(el.clientWidth / CELL_WIDTH));
    const height = Math.max(5, Math.floor(el.clientHeight / CELL_HEIGHT));
    void api.resizeExec(id, width, height).catch(() => {});
  }, []);

  useEffect(() => {
    if (status !== "open") return;
    reportSize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reportSize);
    if (viewRef.current) observer.observe(viewRef.current);
    return () => observer.disconnect();
  }, [status, reportSize]);

  useEffect(() => {
    const el = viewRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  async function send(text: string) {
    const id = sessionId.current;
    if (id === null) return;
    try {
      await api.writeExec(id, text);
    } catch (e) {
      setError(errorMessage(e));
      setStatus("closed");
    }
  }

  if (blocked) {
    return (
      <p className="px-4 py-6 text-center text-sm text-content-muted">
        This context is marked read-only in Loupe, so no terminal is offered.
        A shell is a write however it is used.
      </p>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[rgb(var(--code-bg))]">
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
        <span className="text-2xs text-content-muted">
          {status === "opening"
            ? "opening a shell…"
            : status === "open"
              ? shell
              : "closed"}
        </span>
        <span
          className="ml-auto text-2xs text-content-muted"
          title="Escape sequences are stripped rather than interpreted — this is a place to run ls and cat, not vim"
        >
          plain output
        </span>
      </div>

      {error && (
        <div
          role="alert"
          className="animate-fade-in border-b border-danger/20 bg-danger/[0.08] px-4 py-2 text-xs text-danger"
        >
          {error}
        </div>
      )}

      <pre
        ref={viewRef}
        data-testid="terminal-output"
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-4 py-2 font-mono text-xs leading-[1.6] text-[rgb(var(--code-fg))]"
      >
        {output}
      </pre>

      <div className="flex items-center gap-2 border-t px-4 py-2">
        <span aria-hidden className="shrink-0 font-mono text-xs text-content-muted">
          ❯
        </span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={status !== "open"}
          aria-label="Terminal input"
          autoComplete="off"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void send(`${input}\n`);
              setInput("");
            } else if (e.key === "c" && e.ctrlKey) {
              // Interrupt, rather than the browser's copy — there is
              // nothing else Ctrl-C can usefully mean in a terminal.
              e.preventDefault();
              void send("");
            } else if (e.key === "d" && e.ctrlKey) {
              e.preventDefault();
              void send("");
            }
          }}
          className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-content-muted disabled:opacity-50"
          placeholder={status === "open" ? "" : "no shell"}
        />
      </div>
    </div>
  );
}
