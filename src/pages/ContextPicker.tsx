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
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo className="mb-3 h-14 w-14" />
          <h1 className="text-xl font-semibold">Loupe</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {current
              ? "Switch to another cluster."
              : "Choose a cluster to connect to."}
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">
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
          <p className="text-center text-sm text-slate-500 dark:text-slate-400">
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
                className="mb-2 w-full rounded border border-slate-300 bg-transparent px-2 py-1.5 text-sm placeholder:text-slate-400 focus:border-accent focus:outline-none dark:border-slate-700"
              />
            )}

            <ul className="divide-y divide-slate-200 overflow-hidden rounded border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
              {filtered.map((ctx) => {
                const active = current?.context === ctx.name;
                return (
                  <li key={ctx.name}>
                    <button
                      onClick={() => connect(ctx.name)}
                      disabled={connecting !== null}
                      className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-slate-50 disabled:opacity-60 dark:hover:bg-slate-900"
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
                        <span className="mt-0.5 block truncate text-xs text-slate-500 dark:text-slate-400">
                          {ctx.cluster}
                          {ctx.namespace ? ` · ${ctx.namespace}` : ""}
                        </span>
                      </span>
                      <span className="ml-3 shrink-0 text-xs text-slate-400">
                        {connecting === ctx.name ? "Connecting…" : "→"}
                      </span>
                    </button>
                  </li>
                );
              })}
              {filtered.length === 0 && (
                <li className="px-4 py-6 text-center text-sm text-slate-500">
                  Nothing matches “{query}”.
                </li>
              )}
            </ul>
          </>
        )}

        {onCancel && (
          <button
            onClick={onCancel}
            className="mt-4 w-full text-center text-sm text-slate-500 underline-offset-2 hover:underline dark:text-slate-400"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
