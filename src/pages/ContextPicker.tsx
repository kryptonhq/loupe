import { useEffect, useState } from "react";
import { Logo } from "../components/Logo";
import { Chip } from "../components/Chip";
import { SkeletonBlock } from "../components/Skeleton";
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

  useEffect(() => {
    api
      .listContexts()
      .then(setContexts)
      .catch((e) => {
        setContexts([]);
        setError(errorMessage(e));
      });
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

  const filtered = (contexts ?? []).filter((c) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return `${c.name} ${c.cluster} ${c.namespace ?? ""}`
      .toLowerCase()
      .includes(q);
  });

  return (
    <div className="ambient drag-region flex h-full items-center justify-center p-8">
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
            {contexts.length > 5 && (
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter contexts…"
                className="mb-2 w-full rounded-sm border bg-content/[0.03] px-2.5 py-1.5 text-sm transition-colors duration-150 ease-swift placeholder:text-content-muted focus:border-accent/40"
              />
            )}

            <ul className="glass-overlay divide-y divide-hairline/[0.06] overflow-hidden p-0">
              {filtered.map((ctx) => {
                const active = current?.context === ctx.name;
                return (
                  <li key={ctx.name}>
                    <button
                      onClick={() => connect(ctx.name)}
                      disabled={connecting !== null}
                      className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors duration-150 ease-swift hover:bg-content/[0.05] disabled:opacity-60"
                    >
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="truncate font-medium">
                            {ctx.name}
                          </span>
                          {active && <Chip tone="ok">connected</Chip>}
                          {ctx.isCurrent && !active && (
                            <Chip tone="accent">kubeconfig default</Chip>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-2xs text-content-muted">
                          {ctx.cluster}
                          {ctx.namespace ? ` · ${ctx.namespace}` : ""}
                        </span>
                      </span>
                      <span className="ml-3 shrink-0 text-xs text-content-muted">
                        {connecting === ctx.name ? "Connecting…" : "→"}
                      </span>
                    </button>
                  </li>
                );
              })}
              {filtered.length === 0 && (
                <li className="px-4 py-6 text-center text-sm text-content-muted">
                  Nothing matches “{query}”.
                </li>
              )}
            </ul>
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
