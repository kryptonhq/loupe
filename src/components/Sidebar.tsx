import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Logo } from "./Logo";
import { dragRegionProps } from "../lib/window";
import { KIND_SECTIONS, type KindEntry } from "../lib/kinds";
import { api, type ApiResourceInfo, type ClusterInfo } from "../lib/api";

/// Which pane the main area is showing.
///
/// `kind` covers everything driven by a server-printed table — the
/// sidebar's workloads, networking, config and storage entries, and any
/// custom resource picked from the CRDs section. The rest have views
/// with more than a table behind them.
export type View =
  | { type: "nodes" }
  | { type: "namespaces" }
  | { type: "pods" }
  | { type: "crds" }
  | { type: "helm" }
  | { type: "kind"; entry: KindEntry };

// Each resource gets a mark rather than an icon font. The references
// that read well all use colour to make the left rail scannable — you
// learn the shape and stop reading the label.
type Item = { id: View["type"]; label: string; tint: string; glyph: string };

const CLUSTER_ITEMS: Item[] = [
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
  onSwitchCluster: () => void;
  onDisconnect: () => void;
}

/// The kind a `kind` view is showing, or null for anything else.
function selectedKindId(view: View) {
  return view.type === "kind" ? view.entry.id : null;
}

/// A nav row for one kind, at the indent the sections use.
function KindRow({
  label,
  active,
  title,
  onSelect,
}: {
  label: string;
  active: boolean;
  title?: string;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      title={title}
      className={`mb-0.5 flex w-full items-center rounded py-1 pl-8 pr-2 text-left text-sm transition-colors duration-150 ease-swift ${
        active
          ? "bg-accent/[0.14] font-medium text-content"
          : "text-content-secondary hover:bg-content/[0.05] hover:text-content"
      }`}
    >
      <span className="truncate">{label}</span>
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 pb-1 pt-3 text-2xs font-medium uppercase tracking-wide text-content-muted">
      {children}
    </p>
  );
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

/// The CRDs section: the cluster's own custom kinds.
///
/// Collapsible, unlike the fixed sections, because its length is set by
/// whatever operators are installed — thirteen on a modest cluster, and
/// far more on a busy one.
///
/// Only custom kinds are listed. The built-ins worth a rail entry are
/// already in the sections above, and the rest are on the index page.
function CrdSection({
  selectedId,
  enabled,
  onOpenIndex,
  onSelectKind,
  indexActive,
}: {
  selectedId: string | null;
  enabled: boolean;
  onOpenIndex: () => void;
  onSelectKind: (entry: KindEntry) => void;
  indexActive: boolean;
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

  const crds: { entry: KindEntry; resource: ApiResourceInfo }[] = (q.data ?? [])
    .filter((r) => r.custom)
    .map((r) => ({
      resource: r,
      entry: {
        id: `${r.group}/${r.version}/${r.kind}`,
        label: r.kind,
        gvk: { group: r.group, version: r.version, kind: r.kind },
      },
    }));

  const selectedHere = crds.some((c) => c.entry.id === selectedId);

  // Arriving at a CRD from somewhere else — the index table, say —
  // should reveal it in the rail, not leave the section shut over the
  // thing that is on screen.
  useEffect(() => {
    if (selectedHere) setOpen(true);
  }, [selectedHere]);

  return (
    <>
      <div className="mb-0.5 flex items-stretch">
        <button
          onClick={() => {
            setOpen(true);
            onOpenIndex();
          }}
          disabled={!enabled}
          className={`${itemClass(indexActive)} mb-0 flex-1`}
        >
          <span
            aria-hidden
            className={`w-3.5 text-center text-xs ${indexActive ? CRD_MARK.tint : "text-content-muted group-hover:" + CRD_MARK.tint}`}
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
          {crds.map(({ entry, resource }, i) => {
            // A heading whenever the API group changes. Thirteen kinds
            // from four operators read as four things this way, and as
            // one undifferentiated list without it.
            const newGroup = i === 0 || crds[i - 1].resource.group !== resource.group;
            return (
              <li key={entry.id}>
                {newGroup && (
                  <p
                    className="truncate px-2 pb-0.5 pl-8 pt-1.5 text-2xs text-content-muted"
                    title={resource.group}
                  >
                    {resource.group}
                  </p>
                )}
                <KindRow
                  label={entry.label}
                  active={entry.id === selectedId}
                  title={`${resource.group}/${resource.version}`}
                  onSelect={() => onSelectKind(entry)}
                />
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
  onSwitchCluster,
  onDisconnect,
}: SidebarProps) {
  const selectedId = selectedKindId(view);

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

      {/* Scrolls: between the fixed sections and whatever CRDs the
          cluster has, this list is not a fixed height. */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <SectionLabel>Cluster</SectionLabel>
        {CLUSTER_ITEMS.map((item) => (
          <NavItem
            key={item.id}
            item={item}
            active={view.type === item.id}
            disabled={!cluster}
            onSelect={() => onSelect({ type: item.id } as View)}
          />
        ))}

        {/* Workloads, network, config, storage — all one component,
            because the API server prints the columns for every one. */}
        {KIND_SECTIONS.map((section) => (
          <div key={section.title}>
            <SectionLabel>{section.title}</SectionLabel>
            {section.items.map((entry) => (
              <KindRow
                key={entry.id}
                label={entry.label}
                active={entry.id === selectedId}
                onSelect={() => onSelect({ type: "kind", entry })}
              />
            ))}
          </div>
        ))}

        <SectionLabel>Extensions</SectionLabel>
        <CrdSection
          selectedId={selectedId}
          indexActive={view.type === "crds"}
          enabled={cluster != null}
          onOpenIndex={() => onSelect({ type: "crds" })}
          onSelectKind={(entry) => onSelect({ type: "kind", entry })}
        />

        <NavItem
          item={HELM}
          active={view.type === "helm"}
          disabled={!cluster}
          onSelect={() => onSelect({ type: "helm" })}
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
