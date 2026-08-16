import { useEffect, useMemo, useRef, useState } from "react";
import { useXTerm } from "react-xtermjs";
import { FitAddon } from "@xterm/addon-fit";
// Imported here, not left to react-xtermjs. Its *type declaration* says
// it imports this, but its compiled JS does not — so trusting the
// declaration ships a bundle with all of xterm's JavaScript and none of
// its CSS, and the terminal renders as an unstyled div: present,
// running, and plainly not a terminal. Nothing in jsdom can see this,
// which is why there is a test asserting the import itself.
import "@xterm/xterm/css/xterm.css";
import {
  Channel,
  api,
  errorMessage,
  type ContainerView,
  type ExecEvent,
} from "../lib/api";
import { Select } from "./Select";
import { useCluster } from "../lib/clusterContext";

// A shell inside a container.
//
// This is a real terminal emulator, not a text box that sends lines. The
// first version was the latter — a <pre> for output and an <input> that
// posted on Enter — and it could not work: no arrow keys, no tab
// completion, no Ctrl-R, no `less`, and every escape sequence had to be
// stripped by hand because there was nothing to interpret them. Doing
// that by hand went wrong in the obvious way, and the result was output
// that looked mangled and typing that looked ignored.
//
// xterm.js is a large dependency and the right one: the escape sequences
// exist for it, and a terminal that cannot interpret them is not a
// terminal. `useXTerm` owns the mount and dispose lifecycle, which is
// the part that is easy to get subtly wrong.
//
// The division of labour is unchanged and is the part that matters:
// every keystroke goes to Rust as raw bytes and every byte comes back
// the same way. The webview holds no connection to the API server.

/// Floors for a pane too small to measure sensibly. Everything else is
/// computed from the element, so nothing here assumes a font size.
const MIN_COLS = 20;
const MIN_ROWS = 5;

/// One of the app's colour tokens, as something xterm will accept.
///
/// The tokens hold bare `R G B` triples because Tailwind composes them
/// with an alpha; xterm wants a colour string. Falls back rather than
/// throwing, since a terminal with slightly wrong colours beats no
/// terminal.
function cssColour(token: string, fallback: string): string {
  if (typeof getComputedStyle !== "function") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(token)
    .trim();
  return value ? `rgb(${value})` : fallback;
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

  // A shell is a write whatever it is used for, so a context marked
  // read-only does not hand one out. The backend refuses too; this is so
  // the user is told why rather than shown a terminal that fails.
  //
  // Split into its own component rather than an early return, so the
  // terminal's hooks are never conditionally called.
  if (guard === "readOnly") {
    return (
      <p className="px-4 py-6 text-center text-sm text-content-muted">
        This context is marked read-only in Loupe, so no terminal is offered. A
        shell is a write however it is used.
      </p>
    );
  }

  return <ShellSession namespace={namespace} pod={pod} containers={containers} />;
}

function ShellSession({
  namespace,
  pod,
  containers,
}: {
  namespace: string;
  pod: string;
  containers: ContainerView[];
}) {
  const [container, setContainer] = useState(containers[0]?.name ?? "");
  const [shell, setShell] = useState<string | null>(null);
  const [status, setStatus] = useState<"opening" | "open" | "closed">("opening");
  const [error, setError] = useState<string | null>(null);

  // Held in a ref so the keystroke handler is a stable closure that
  // always sees the current session rather than the one it was created
  // with.
  const sessionId = useRef<number | null>(null);

  // Every argument to useXTerm has to keep its identity across renders.
  // The hook rebuilds the terminal on `[options, addons]` and re-binds
  // on `[listeners]`, so a fresh object literal each render rebuilds it
  // each render — and since rebuilding sets state, that is an infinite
  // loop. It presents as a terminal stuck on "opening", a black pane
  // that never paints, and exec sessions opened and closed against the
  // cluster as fast as React can render.
  const fit = useMemo(() => new FitAddon(), []);
  const addons = useMemo(() => [fit], [fit]);

  const options = useMemo(
    () => ({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      // Taken from the app's own palette rather than left transparent:
      // xterm ignores an alpha background unless `allowTransparency` is
      // on, and the result is a black rectangle in light mode.
      theme: {
        background: cssColour("--code-bg", "#1e1e1e"),
        foreground: cssColour("--code-fg", "#d4d4d4"),
      },
      // Bounded for the same reason the log viewer is: a command that
      // prints forever must not grow memory without limit.
      scrollback: 5000,
    }),
    [],
  );

  const listeners = useMemo(
    () => ({
      // Every keystroke, as the terminal encodes it — arrows, Tab,
      // Ctrl-C, paste, all of it. This is what the old input box could
      // not do. Reads the session from a ref so the handler can be built
      // once and still see the current session.
      onData: (data: string) => {
        const id = sessionId.current;
        // xterm is live as soon as it mounts; anything typed before the
        // session exists has nowhere to go.
        if (id === null) return;
        void api.writeExec(id, data).catch((e) => {
          setError(errorMessage(e));
          setStatus("closed");
        });
      },
    }),
    [],
  );

  const { ref, instance } = useXTerm({ options, addons, listeners });

  useEffect(() => {
    if (!instance || !container) return;

    let cancelled = false;
    setError(null);
    setShell(null);
    setStatus("opening");

    const resize = () => {
      try {
        fit.fit();
      } catch {
        // `fit` throws while the pane has no layout — during a tab
        // change, for instance. The next resize will land.
        return;
      }
      const id = sessionId.current;
      if (id === null) return;
      void api
        .resizeExec(
          id,
          Math.max(MIN_COLS, instance.cols),
          Math.max(MIN_ROWS, instance.rows),
        )
        .catch(() => {});
    };

    const channel = new Channel<ExecEvent>();
    channel.onmessage = (event) => {
      if (cancelled) return;
      switch (event.kind) {
        case "started":
          setShell(event.shell);
          setStatus("open");
          // Sized once the session exists; before that there is nothing
          // to tell.
          resize();
          break;
        case "output":
          // Written raw. Interpreting the escapes is the whole reason
          // this is an emulator rather than a text box.
          instance.write(event.data);
          break;
        case "ended":
          setStatus("closed");
          instance.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
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
        resize();
        instance.focus();
      })
      .catch((e) => {
        if (cancelled) return;
        setError(errorMessage(e));
        setStatus("closed");
      });

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    if (ref.current) observer?.observe(ref.current);

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (sessionId.current !== null) {
        void api.closeExec(sessionId.current);
        sessionId.current = null;
      }
      // Clearing keeps one container's output from appearing under the
      // next one's name when only the container changes — the terminal
      // itself survives that. On unmount useXTerm has already disposed
      // it by the time this runs, and clearing a disposed terminal
      // throws, which is noise rather than information.
      try {
        instance.clear();
      } catch {
        // Already disposed.
      }
    };
    // `ref` and `fit` are stable by construction — a ref object and a
    // useMemo — and are deliberately not dependencies. Listing them
    // would restart the session on any render where a wrapper happened
    // to hand back a new object, which tears down a working shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, namespace, pod, container]);

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
      </div>

      {error && (
        <div
          role="alert"
          className="animate-fade-in border-b border-danger/20 bg-danger/[0.08] px-4 py-2 text-xs text-danger"
        >
          {error}
        </div>
      )}

      <div
        ref={ref}
        data-testid="terminal"
        // Clicking anywhere in the pane focuses the terminal, which is
        // what a terminal does.
        onMouseDown={() => instance?.focus()}
        className="min-h-0 flex-1 overflow-hidden px-2 py-1"
      />
    </div>
  );
}
