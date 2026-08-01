import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ResourceTable } from "../components/ResourceTable";
import { type Column } from "../components/Table";
import { Chip, ChipList } from "../components/Chip";
import { Panel } from "../components/Panel";
import { Select } from "../components/Select";
import { StatusDot, phaseTone } from "../components/StatusDot";
import {
  api,
  type NamespaceSummary,
  type NodeSummary,
  type PodSummary,
} from "../lib/api";
import { PodDetail } from "./PodDetail";
import { NodeDetail } from "./NodeDetail";
import { NamespaceDetail } from "./NamespaceDetail";

export function Nodes() {
  const [selected, setSelected] = useState<string | null>(null);

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
          tone={n.ready ? "ok" : "danger"}
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

  if (selected) {
    return <NodeDetail name={selected} onClose={() => setSelected(null)} />;
  }

  return (
    <Panel
      title="Nodes"
      subtitle="Cluster capacity and readiness"
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
        onRowClick={(n) => setSelected(n.name)}
      />
    </Panel>
  );
}

export function Namespaces() {
  const [selected, setSelected] = useState<string | null>(null);

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

  if (selected) {
    return (
      <NamespaceDetail name={selected} onClose={() => setSelected(null)} />
    );
  }

  return (
    <Panel
      title="Namespaces"
      subtitle="Tenancy boundaries in this cluster"
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
        onRowClick={(n) => setSelected(n.name)}
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
          <Chip tone={p.restarts > 5 ? "danger" : "warn"}>{p.restarts}</Chip>
        ) : (
          <span className="text-content-muted">0</span>
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
      subtitle="Workloads currently scheduled"
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
          <Select value={namespace} onChange={setNamespace}>
            <option value="">All namespaces</option>
            {(namespaces.data ?? []).map((ns) => (
              <option key={ns.name} value={ns.name}>
                {ns.name}
              </option>
            ))}
          </Select>
        }
      />
    </Panel>
  );
}
