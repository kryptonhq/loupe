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
import type { OpenIntent } from "../lib/routes";

// The three listings that have a view of their own rather than a
// server-printed table.
//
// Each one is now a listing and nothing else: what happens when a row is
// opened is the workspace's business, so the same row can go to this tab
// or to a new one, and the trail behind it survives. Previously each of
// these held a `selected` and swapped itself for a detail view, which is
// why there was nothing to go back to.

interface ListProps<T> {
  onOpen: (target: T, intent: OpenIntent) => void;
}

/// Worst first. Sorting a status column alphabetically puts Failed
/// beside Pending by accident and Running between them; this orders by
/// what the tone already says about how much attention it wants.
const PHASE_ORDER = ["danger", "warn", "ok", "unknown"] as const;

export function Nodes({ onOpen }: ListProps<NodeSummary>) {
  const q = useQuery({
    queryKey: ["nodes"],
    queryFn: () => api.listNodes(),
  });

  const columns: Column<NodeSummary>[] = [
    { key: "name", header: "Name", render: (n) => n.name, sortValue: (n) => n.name },
    {
      key: "status",
      header: "Status",
      render: (n) => (
        <StatusDot
          tone={n.ready ? "ok" : "danger"}
          label={n.ready ? "Ready" : "NotReady"}
        />
      ),
      // NotReady first, because that is the node you are looking for.
      sortValue: (n) => (n.ready ? 1 : 0),
    },
    {
      key: "roles",
      header: "Roles",
      // Chips rather than a comma-joined string: a node with three
      // roles should read as three things, not one long value.
      render: (n) => <ChipList values={n.roles} tone="accent" />,
      sortValue: (n) => n.roles.join(" "),
    },
    {
      key: "version",
      header: "Version",
      render: (n) => n.version,
      mono: true,
      sortValue: (n) => n.version,
    },
    {
      key: "age",
      header: "Age",
      render: (n) => n.age ?? "—",
      mono: true,
      sortValue: (n) => n.age,
    },
  ];

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
        onRowClick={onOpen}
      />
    </Panel>
  );
}

export function Namespaces({ onOpen }: ListProps<NamespaceSummary>) {
  const q = useQuery({
    queryKey: ["namespaces"],
    queryFn: () => api.listNamespaces(),
  });

  const columns: Column<NamespaceSummary>[] = [
    { key: "name", header: "Name", render: (n) => n.name, sortValue: (n) => n.name },
    {
      key: "phase",
      header: "Status",
      render: (n) => (
        <StatusDot tone={n.phase === "Active" ? "ok" : "warn"} label={n.phase} />
      ),
      // Terminating before Active: a namespace that will not go away is
      // the one worth finding.
      sortValue: (n) => (n.phase === "Active" ? 1 : 0),
    },
    {
      key: "age",
      header: "Age",
      render: (n) => n.age ?? "—",
      mono: true,
      sortValue: (n) => n.age,
    },
  ];

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
        onRowClick={onOpen}
      />
    </Panel>
  );
}

export function Pods({ onOpen }: ListProps<PodSummary>) {
  // Empty string means all namespaces, matching kubectl -A.
  const [namespace, setNamespace] = useState("");

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
    { key: "name", header: "Name", render: (p) => p.name, sortValue: (p) => p.name },
    {
      key: "namespace",
      header: "Namespace",
      render: (p) => p.namespace,
      sortValue: (p) => p.namespace,
    },
    {
      key: "phase",
      header: "Status",
      render: (p) => <StatusDot tone={phaseTone(p.phase)} label={p.phase} />,
      // By how much the phase should worry you rather than by its name,
      // so Failed and Pending come up together ahead of Running instead
      // of landing either side of it alphabetically.
      sortValue: (p) => PHASE_ORDER.indexOf(phaseTone(p.phase)),
    },
    {
      key: "ready",
      header: "Ready",
      render: (p) => p.ready,
      mono: true,
      // "0/1" before "2/3" before "1/1" — least ready first, which is
      // what the column is scanned for.
      sortValue: (p) => p.ready,
    },
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
      sortValue: (p) => p.restarts,
    },
    {
      key: "node",
      header: "Node",
      render: (p) => p.node ?? "—",
      sortValue: (p) => p.node,
    },
    {
      key: "age",
      header: "Age",
      render: (p) => p.age ?? "—",
      mono: true,
      sortValue: (p) => p.age,
    },
  ];

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
        onRowClick={onOpen}
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
