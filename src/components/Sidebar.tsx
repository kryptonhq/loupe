import { Logo } from "./Logo";
import type { ClusterInfo } from "../lib/api";

export type View = "nodes" | "namespaces" | "pods";

const ITEMS: { id: View; label: string }[] = [
  { id: "nodes", label: "Nodes" },
  { id: "namespaces", label: "Namespaces" },
  { id: "pods", label: "Pods" },
];

interface SidebarProps {
  cluster: ClusterInfo | null;
  view: View;
  onSelect: (v: View) => void;
  onSwitchCluster: () => void;
  onDisconnect: () => void;
}

export function Sidebar({
  cluster,
  view,
  onSelect,
  onSwitchCluster,
  onDisconnect,
}: SidebarProps) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-2 px-4 py-4">
        <Logo className="h-7 w-7" />
        <span className="font-semibold">Loupe</span>
      </div>

      <nav className="flex-1 px-2">
        {ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => onSelect(item.id)}
            disabled={!cluster}
            className={`mb-0.5 w-full rounded px-3 py-1.5 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              view === item.id
                ? "bg-accent text-accent-fg"
                : "text-slate-700 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {cluster && (
        <div className="border-t border-slate-200 p-2 dark:border-slate-800">
          {/* The cluster chip doubles as the context switcher — the
              thing people reach for most after picking the wrong one. */}
          <button
            onClick={onSwitchCluster}
            title={`${cluster.server}\nClick to switch cluster`}
            className="w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-slate-200 dark:hover:bg-slate-800"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-medium">
                {cluster.context}
              </span>
              <span className="shrink-0 text-xs text-slate-400">⇄</span>
            </span>
            <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
              {cluster.version}
            </span>
          </button>

          <button
            onClick={onDisconnect}
            className="mt-1 w-full px-2 text-left text-xs text-slate-500 underline-offset-2 hover:underline dark:text-slate-400"
          >
            Disconnect
          </button>
        </div>
      )}
    </aside>
  );
}
