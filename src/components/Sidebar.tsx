import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Logo } from "./Logo";
import { dragRegionProps } from "../lib/window";
import { api, type ApiResourceInfo, type ClusterInfo } from "../lib/api";

export type View = "nodes" | "namespaces" | "pods" | "crds" | "helm";

// Each resource gets a mark rather than an icon font. The references
// that read well all use colour to make the left rail scannable — you
// learn the shape and stop reading the label.
type Item = { id: View; label: string; tint: string; glyph: string };

const ITEMS: Item[] = [
  { id: "nodes", label: "Nodes", tint: "text-info", glyph: "▤" },
  { id: "namespaces", label: "Namespaces", tint: "text-accent", glyph: "◇" },
  { id: "pods", label: "Pods", tint: "text-success", glyph: "◉" },
];

const HELM: Item = { id: "helm", label: "Helm", tint: "text-info", glyph: "⎈" };

const CRD_MARK = { tint: "text-warn", glyph: "❖" };

interface SidebarProps {
  cluster: ClusterInfo | null;
  view: View;
  onSelect: (v: View) => void;
  /// The CRD whose objects the main pane is showing, if any.
  crd: ApiResourceInfo | null;
  onSelectCrd: (resource: ApiResourceInfo | null) => void;
  onSwitchCluster: () => void;
  onDisconnect: () => void;
}

function itemClass(active: boolean) {
  return `group mb-0.5 flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-sm transition-all duration-150 ease-swift disabled:cursor-not-allowed disabled:opacity-40 ${
    active
      ? "bg-accent/[0.14] font-medium text-content"
      : "text-content-secondary hover:bg-content/[0.05] hover:text-content"
  }`;
}

function NavItem({
  item,
  active,
  disabled,
  onSelect,
}: {
  item: Item;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button onClick={onSelect} disabled={disabled} className={itemClass(active)}>
      <span
        aria-hidden
        className={`w-3.5 text-center text-xs ${active ? item.tint : "text-content-muted group-hover:" + item.tint}`}
      >
        {item.glyph}
      </span>
      {item.label}
    </button>
  );
}

/// The CRDs section: a nav item that opens into the cluster's own custom
/// kinds.
///
/// Only custom kinds are listed here. The built-ins stay on the index
/// page — putting all seventy in the rail would bury the two an operator
/// installed an operator for, which are the ones they came to click.
function CrdSection({
  active,
  selected,
  enabled,
  onOpenIndex,
  onSelectCrd,
}: {
  active: boolean;
  selected: ApiResourceInfo | null;
  enabled: boolean;
  onOpenIndex: () => void;
  onSelectCrd: (resource: ApiResourceInfo) => void;
}) {
  const [open, setOpen] = useState(false);

  const q = useQuery({
    queryKey: ["api-resources"],
    queryFn: () => api.listApiResources(),
    // Shared with the index page, and the API surface only changes when
    // someone installs a CRD — not worth rediscovering per mount.
    staleTime: 5 * 60 * 1000,
    enabled,
  });

  const crds = (q.data ?? []).filter((r) => r.custom);

  // Arriving at a CRD from somewhere else — the index table, say —
  // should reveal it in the rail, not leave the section shut over the
  // thing that is on screen.
  useEffect(() => {
    if (selected) setOpen(true);
  }, [selected]);

  return (
    <>
      <div className="mb-0.5 flex items-stretch">
        <button
          onClick={() => {
            setOpen(true);
            onOpenIndex();
          }}
          disabled={!enabled}
          className={`${itemClass(active && !selected)} mb-0 flex-1`}
        >
          <span
            aria-hidden
            className={`w-3.5 text-center text-xs ${active ? CRD_MARK.tint : "text-content-muted group-hover:" + CRD_MARK.tint}`}
          >
            {CRD_MARK.glyph}
          </span>
          CRDs
          {crds.length > 0 && (
            <span className="ml-auto text-2xs tabular-nums text-content-muted">
              {crds.length}
            </span>
          )}
        </button>

        {/* Separate from the row so collapsing the list and navigating
            to the index are not the same click. */}
        <button
          onClick={() => setOpen((o) => !o)}
          disabled={!enabled || crds.length === 0}
          aria-expanded={open}
          aria-label={open ? "Collapse CRDs" : "Expand CRDs"}
          className="ml-0.5 rounded px-1.5 text-2xs text-content-muted transition-colors hover:bg-content/[0.05] hover:text-content disabled:opacity-0"
        >
          <span
            aria-hidden
            className={`inline-block transition-transform duration-150 ease-swift ${open ? "rotate-90" : ""}`}
          >
            ›
          </span>
        </button>
      </div>

      {open && crds.length > 0 && (
        <ul className="mb-1 animate-fade-in">
          {crds.map((r, i) => {
            const isSelected =
              selected?.kind === r.kind && selected?.group === r.group;
            // A heading whenever the API group changes. Thirteen kinds
            // from four operators read as four things this way, and as
            // one undifferentiated list without it.
            const newGroup = i === 0 || crds[i - 1].group !== r.group;

            return (
              <li key={`${r.group}/${r.version}/${r.kind}`}>
                {newGroup && (
                  <p
                    className="truncate px-2 pb-0.5 pl-8 pt-1.5 text-2xs text-content-muted"
                    title={r.group}
                  >
                    {r.group}
                  </p>
                )}
                <button
                  onClick={() => onSelectCrd(r)}
                  title={`${r.group}/${r.version}`}
                  className={`mb-0.5 flex w-full items-center rounded py-1 pl-8 pr-2 text-left text-sm transition-colors duration-150 ease-swift ${
                    isSelected
                      ? "bg-accent/[0.14] font-medium text-content"
                      : "text-content-secondary hover:bg-content/[0.05] hover:text-content"
                  }`}
                >
                  <span className="truncate">{r.kind}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

export function Sidebar({
  cluster,
  view,
  onSelect,
  crd,
  onSelectCrd,
  onSwitchCluster,
  onDisconnect,
}: SidebarProps) {
  return (
    <aside className="glass flex w-60 shrink-0 flex-col border-r">
      {/* Padded down past the macOS traffic lights, which are overlaid
          on our content by titleBarStyle: Overlay. */}
      <div
        {...dragRegionProps}
        className="drag-region flex items-center gap-2.5 px-4 pb-3 pt-10"
      >
        <Logo className="h-6 w-6" />
        <span className="text-sm font-semibold tracking-tight">Loupe</span>
      </div>

      {/* Scrolls: the CRD list is as long as the cluster makes it. */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-2">
        <p className="px-2 pb-1.5 pt-2 text-2xs font-medium uppercase tracking-wide text-content-muted">
          Cluster
        </p>

        {ITEMS.map((item) => (
          <NavItem
            key={item.id}
            item={item}
            active={view === item.id}
            disabled={!cluster}
            onSelect={() => onSelect(item.id)}
          />
        ))}

        <CrdSection
          active={view === "crds"}
          selected={view === "crds" ? crd : null}
          enabled={cluster != null}
          onOpenIndex={() => {
            onSelectCrd(null);
            onSelect("crds");
          }}
          onSelectCrd={(r) => {
            onSelectCrd(r);
            onSelect("crds");
          }}
        />

        <NavItem
          item={HELM}
          active={view === "helm"}
          disabled={!cluster}
          onSelect={() => onSelect("helm")}
        />
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
