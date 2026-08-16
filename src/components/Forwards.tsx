import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, type ForwardTarget, type ForwardView } from "../lib/api";

// Port forwards: starting them, and the panel that lists them.
//
// The panel is the feature. A terminal gives you one forward per window,
// no memory of what you had open, and a connection that dies on pod
// churn without saying so. Holding several, showing their state, and
// releasing their ports on quit is the part a desktop app is actually
// better at.

/// How often the panel refreshes byte and connection counts.
///
/// A forward that is doing nothing has to be distinguishable from one
/// that is broken, and the only difference between them is whether the
/// numbers move.
const REFRESH_MS = 2000;

/// Formats a byte count for a table cell.
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/// One line describing where a forward points.
export function describeTarget(target: ForwardTarget): string {
  return `${target.kind === "service" ? "svc" : "pod"}/${target.name}`;
}

export function ForwardsPanel() {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ["forwards"],
    queryFn: () => api.listForwards(),
    refetchInterval: REFRESH_MS,
  });

  const stop = useMutation({
    mutationFn: (id: number) => api.stopForward(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["forwards"] }),
  });

  const forwards = q.data ?? [];
  if (forwards.length === 0) return null;

  return (
    <div className="border-t">
      <p className="px-4 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-content-muted">
        Port forwards
      </p>
      <ul>
        {forwards.map((forward) => (
          <ForwardRow
            key={forward.id}
            forward={forward}
            onStop={() => stop.mutate(forward.id)}
            stopping={stop.isPending && stop.variables === forward.id}
          />
        ))}
      </ul>
    </div>
  );
}

function ForwardRow({
  forward,
  onStop,
  stopping,
}: {
  forward: ForwardView;
  onStop: () => void;
  stopping: boolean;
}) {
  const url = `http://localhost:${forward.localPort}`;
  const [copied, setCopied] = useState(false);

  return (
    <li className="flex items-center gap-2 px-4 py-1.5 text-xs">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono">
          {forward.localPort} → {describeTarget(forward.target)}:
          {forward.remotePort}
        </span>
        <span className="block truncate text-2xs text-content-muted">
          {forward.connections} connection
          {forward.connections === 1 ? "" : "s"} · {formatBytes(forward.bytes)}
          {forward.lastError && (
            // Kept rather than cleared: a forward that failed an hour ago
            // still needs to say why, or it just looks idle.
            <span className="text-warn"> · {forward.lastError}</span>
          )}
        </span>
      </span>

      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            setCopied(false);
          }
        }}
        title={`Copy ${url}`}
        className="shrink-0 rounded-sm border px-1.5 py-0.5 text-2xs text-content-secondary transition-colors hover:bg-content/[0.06] hover:text-content"
      >
        {copied ? "copied" : "copy URL"}
      </button>
      <button
        onClick={onStop}
        disabled={stopping}
        className="shrink-0 rounded-sm border border-danger/30 px-1.5 py-0.5 text-2xs text-danger transition-colors hover:bg-danger/[0.1] disabled:opacity-40"
      >
        Stop
      </button>
    </li>
  );
}

/// The control that starts one, for a pod or service detail view.
export function StartForward({
  target,
  /// Ports the object declares, offered as the sensible choices.
  ports,
}: {
  target: ForwardTarget;
  ports: number[];
}) {
  const queryClient = useQueryClient();
  const [remote, setRemote] = useState(String(ports[0] ?? 8080));
  const [local, setLocal] = useState(String(ports[0] ?? 8080));
  const [error, setError] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () => api.startForward(target, Number(local), Number(remote)),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["forwards"] });
    },
    // Reported rather than swallowed: "that port is already in use" is
    // the most common outcome and the one the user can act on.
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-2xs text-content-secondary">
        Local
        <input
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          aria-label="Local port"
          inputMode="numeric"
          className="mt-0.5 block w-20 rounded-sm border bg-content/[0.03] px-2 py-1 font-mono text-xs outline-none focus:border-accent/40"
        />
      </label>
      <span className="pb-1.5 text-content-muted">→</span>
      <label className="text-2xs text-content-secondary">
        Remote
        <input
          value={remote}
          onChange={(e) => setRemote(e.target.value)}
          aria-label="Remote port"
          inputMode="numeric"
          list="forward-ports"
          className="mt-0.5 block w-20 rounded-sm border bg-content/[0.03] px-2 py-1 font-mono text-xs outline-none focus:border-accent/40"
        />
        <datalist id="forward-ports">
          {ports.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </label>

      <button
        onClick={() => start.mutate()}
        disabled={start.isPending || !local || !remote}
        className="rounded-sm bg-accent/[0.18] px-2 py-1 text-2xs font-medium text-accent transition-colors hover:bg-accent/[0.26] disabled:opacity-40"
      >
        {start.isPending ? "Starting…" : "Forward"}
      </button>

      {error && (
        <p role="alert" className="w-full text-2xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
