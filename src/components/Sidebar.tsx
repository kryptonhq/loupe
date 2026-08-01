import { Logo } from "./Logo";
import type { ClusterInfo } from "../lib/api";

export type View = "nodes" | "namespaces" | "pods";

// Each resource gets a mark rather than an icon font. The references
// that read well all use colour to make the left rail scannable — you
// learn the shape and stop reading the label.
const ITEMS: { id: View; label: string; tint: string; glyph: string }[] = [
  { id: "nodes", label: "Nodes", tint: "text-info", glyph: "▤" },
  { id: "namespaces", label: "Namespaces", tint: "text-accent", glyph: "◇" },
  { id: "pods", label: "Pods", tint: "text-success", glyph: "◉" },
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
    <aside className="glass flex w-60 shrink-0 flex-col border-r">
      {/* Padded down past the macOS traffic lights, which are overlaid
          on our content by titleBarStyle: Overlay. */}
      <div className="drag-region flex items-center gap-2.5 px-4 pb-3 pt-10">
        <Logo className="h-6 w-6" />
        <span className="text-sm font-semibold tracking-tight">Loupe</span>
      </div>

      <nav className="flex-1 px-2">
        <p className="px-2 pb-1.5 pt-2 text-2xs font-medium uppercase tracking-wide text-content-muted">
          Cluster
        </p>
        {ITEMS.map((item) => {
          const active = view === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelect(item.id)}
              disabled={!cluster}
              className={`group mb-0.5 flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-sm transition-all duration-150 ease-swift disabled:cursor-not-allowed disabled:opacity-40 ${
                active
                  ? "bg-accent/[0.14] font-medium text-content"
                  : "text-content-secondary hover:bg-content/[0.05] hover:text-content"
              }`}
            >
              <span
                className={`w-3.5 text-center text-xs ${active ? item.tint : "text-content-muted group-hover:" + item.tint}`}
              >
                {item.glyph}
              </span>
              {item.label}
            </button>
          );
        })}
      </nav>

      {cluster && (
        <div className="border-t p-2">
          {/* The cluster chip doubles as the context switcher — the
              thing people reach for most after picking the wrong one. */}
          <button
            onClick={onSwitchCluster}
            title={`${cluster.server}\nClick to switch cluster`}
            className="group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors duration-150 ease-swift hover:bg-content/[0.05]"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success shadow-[0_0_0_3px_rgb(var(--success)/0.15)]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">
                {cluster.context}
              </span>
              <span className="block truncate text-2xs text-content-muted">
                {cluster.version}
              </span>
            </span>
            <span className="shrink-0 text-xs text-content-muted transition-colors group-hover:text-content-secondary">
              ⇄
            </span>
          </button>

          <button
            onClick={onDisconnect}
            className="mt-0.5 w-full rounded px-2 py-1 text-left text-2xs text-content-muted transition-colors hover:bg-content/[0.05] hover:text-content-secondary"
          >
            Disconnect
          </button>
        </div>
      )}
    </aside>
  );
}
