import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ResourceTable } from "../components/ResourceTable";
import { type Column } from "../components/Table";
import { Chip, ChipList } from "../components/Chip";
import { RefreshingDot } from "../components/Skeleton";
import { StatusDot, phaseTone } from "../components/StatusDot";
import {
  api,
  errorMessage,
  type NamespaceSummary,
  type NodeSummary,
  type PodSummary,
} from "../lib/api";
import { PodDetail } from "./PodDetail";

function Panel({
  title,
  error,
  isFetching,
  onRefresh,
  children,
}: {
  title: string;
  error: unknown;
  isFetching: boolean;
  onRefresh: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h2 className="font-semibold">{title}</h2>
        <div className="flex items-center gap-3">
          {/* Shown instead of a skeleton once data exists, so a
              background refetch never blanks the table. */}
          {isFetching && <RefreshingDot />}
          <button
            onClick={onRefresh}
            className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Refresh
          </button>
        </div>
      </header>

      {error != null && (
        <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">
          {errorMessage(error)}
        </div>
      )}

      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

export function Nodes() {
  const q = useQuery({
    queryKey: ["nodes"],
    queryFn: () => api.listNodes(),
  });

  const columns: Column<NodeSummary>[] = [
    { key: "name", header: "Name", render: (n) => n.name },
    {
      key: "status",
      header: "Status",
      render: (n) => (
        <StatusDot
          tone={n.ready ? "ok" : "error"}
          label={n.ready ? "Ready" : "NotReady"}
        />
      ),
    },
    {
      key: "roles",
      header: "Roles",
      // Chips rather than a comma-joined string: a node with three
      // roles should read as three things, not one long value.
      render: (n) => <ChipList values={n.roles} tone="accent" />,
    },
    { key: "version", header: "Version", render: (n) => n.version, mono: true },
    { key: "age", header: "Age", render: (n) => n.age ?? "—", mono: true },
  ];

  return (
    <Panel
      title="Nodes"
      error={q.error}
      isFetching={q.isFetching && !q.isLoading}
      onRefresh={() => q.refetch()}
    >
      <ResourceTable
        columns={columns}
        rows={q.data}
        isLoading={q.isLoading}
        rowKey={(n) => n.name}
        searchText={(n) => `${n.name} ${n.roles.join(" ")} ${n.version}`}
        empty="No nodes visible."
      />
    </Panel>
  );
}

export function Namespaces() {
  const q = useQuery({
    queryKey: ["namespaces"],
    queryFn: () => api.listNamespaces(),
  });

  const columns: Column<NamespaceSummary>[] = [
    { key: "name", header: "Name", render: (n) => n.name },
    {
      key: "phase",
      header: "Status",
      render: (n) => (
        <StatusDot tone={n.phase === "Active" ? "ok" : "warn"} label={n.phase} />
      ),
    },
    { key: "age", header: "Age", render: (n) => n.age ?? "—", mono: true },
  ];

  return (
    <Panel
      title="Namespaces"
      error={q.error}
      isFetching={q.isFetching && !q.isLoading}
      onRefresh={() => q.refetch()}
    >
      <ResourceTable
        columns={columns}
        rows={q.data}
        isLoading={q.isLoading}
        rowKey={(n) => n.name}
        searchText={(n) => `${n.name} ${n.phase}`}
        empty="No namespaces visible."
      />
    </Panel>
  );
}

export function Pods() {
  // Empty string means all namespaces, matching kubectl -A.
  const [namespace, setNamespace] = useState("");
  const [selected, setSelected] = useState<{
    namespace: string;
    name: string;
  } | null>(null);

  const pods = useQuery({
    queryKey: ["pods", namespace],
    queryFn: () => api.listPods(namespace || undefined),
    // Keeps the previous namespace's rows on screen while the new ones
    // load, so switching namespace does not flash an empty table.
    placeholderData: (prev) => prev,
  });

  const namespaces = useQuery({
    queryKey: ["namespaces"],
    queryFn: () => api.listNamespaces(),
  });

  const columns: Column<PodSummary>[] = [
    { key: "name", header: "Name", render: (p) => p.name },
    { key: "namespace", header: "Namespace", render: (p) => p.namespace },
    {
      key: "phase",
      header: "Status",
      render: (p) => <StatusDot tone={phaseTone(p.phase)} label={p.phase} />,
    },
    { key: "ready", header: "Ready", render: (p) => p.ready, mono: true },
    {
      key: "restarts",
      header: "Restarts",
      // A restarting pod is the signal people scan this column for.
      render: (p) =>
        p.restarts > 0 ? (
          <Chip tone={p.restarts > 5 ? "error" : "warn"}>{p.restarts}</Chip>
        ) : (
          <span className="text-slate-400">0</span>
        ),
    },
    { key: "node", header: "Node", render: (p) => p.node ?? "—" },
    { key: "age", header: "Age", render: (p) => p.age ?? "—", mono: true },
  ];

  if (selected) {
    return (
      <PodDetail
        namespace={selected.namespace}
        name={selected.name}
        onClose={() => setSelected(null)}
      />
    );
  }

  return (
    <Panel
      title="Pods"
      error={pods.error}
      isFetching={pods.isFetching && !pods.isLoading}
      onRefresh={() => pods.refetch()}
    >
      <ResourceTable
        columns={columns}
        rows={pods.data}
        isLoading={pods.isLoading}
        rowKey={(p) => `${p.namespace}/${p.name}`}
        searchText={(p) => `${p.name} ${p.namespace} ${p.phase} ${p.node ?? ""}`}
        empty="No pods visible."
        onRowClick={(p) => setSelected({ namespace: p.namespace, name: p.name })}
        toolbar={
          <select
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
            className="shrink-0 rounded border border-slate-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700"
          >
            <option value="">All namespaces</option>
            {(namespaces.data ?? []).map((ns) => (
              <option key={ns.name} value={ns.name}>
                {ns.name}
              </option>
            ))}
          </select>
        }
      />
    </Panel>
  );
}
