import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Panel } from "../components/Panel";
import { ResourceTable } from "../components/ResourceTable";
import { type Column } from "../components/Table";
import { Chip } from "../components/Chip";
import { Select } from "../components/Select";
import { StatusDot } from "../components/StatusDot";
import {
  api,
  type ApiResourceInfo,
  type GvkRef,
  type ObjectSummary,
} from "../lib/api";
import { ObjectDetail, statusTone } from "./ObjectDetail";

// Browsing anything the cluster serves, discovered at runtime.
//
// Two panes in sequence: pick a kind, then look at its objects. The kind
// list leads with custom resources — the built-ins have dedicated views
// already, and an unfiltered list of seventy kinds buries the two an
// operator installed an operator for.

function kindKey(r: ApiResourceInfo) {
  return `${r.group}/${r.version}/${r.kind}`;
}

function Kinds({
  onSelect,
}: {
  onSelect: (resource: ApiResourceInfo) => void;
}) {
  const [showBuiltins, setShowBuiltins] = useState(false);
  const queryClient = useQueryClient();

  const q = useQuery({
    queryKey: ["api-resources"],
    queryFn: () => api.listApiResources(),
    // Discovery is dozens of round trips and the API surface changes
    // only when someone installs a CRD, so it is not worth refetching
    // on every mount.
    staleTime: 5 * 60 * 1000,
  });

  const rows = useMemo(
    () => (q.data ?? []).filter((r) => showBuiltins || r.custom),
    [q.data, showBuiltins],
  );

  const columns: Column<ApiResourceInfo>[] = [
    { key: "kind", header: "Kind", render: (r) => r.kind },
    {
      key: "group",
      header: "API group",
      render: (r) =>
        r.group ? (
          <span className="font-mono text-2xs">{r.group}</span>
        ) : (
          <span className="text-content-muted">core</span>
        ),
    },
    { key: "version", header: "Version", render: (r) => r.version, mono: true },
    {
      key: "scope",
      header: "Scope",
      render: (r) => (
        <Chip tone="neutral">{r.namespaced ? "Namespaced" : "Cluster"}</Chip>
      ),
    },
    {
      key: "writable",
      header: "Access",
      // Whether a kind can be edited is worth knowing before opening
      // one, not after finding no Edit button.
      render: (r) =>
        r.verbs.includes("update") ? (
          <Chip tone="accent">read/write</Chip>
        ) : (
          <Chip tone="neutral">read-only</Chip>
        ),
    },
  ];

  return (
    <Panel
      title="Resources"
      subtitle="Every kind this cluster serves, from API discovery"
      error={q.error}
      isFetching={q.isFetching && !q.isLoading}
      onRefresh={async () => {
        // A full rediscovery, not a refetch of the cache: this button
        // exists for the CRD that was installed a minute ago.
        const fresh = await api.refreshApiResources();
        queryClient.setQueryData(["api-resources"], fresh);
      }}
    >
      <ResourceTable
        columns={columns}
        rows={rows}
        isLoading={q.isLoading}
        rowKey={kindKey}
        searchText={(r) => `${r.kind} ${r.group} ${r.plural}`}
        empty={
          showBuiltins
            ? "No resources discovered."
            : "No custom resources are installed. Show built-in kinds to browse the rest."
        }
        onRowClick={onSelect}
        toolbar={
          <Select
            value={showBuiltins ? "all" : "custom"}
            onChange={(v) => setShowBuiltins(v === "all")}
          >
            <option value="custom">Custom resources</option>
            <option value="all">All kinds</option>
          </Select>
        }
      />
    </Panel>
  );
}

function Objects({
  resource,
  onBack,
}: {
  resource: ApiResourceInfo;
  onBack: () => void;
}) {
  const [namespace, setNamespace] = useState("");
  const [selected, setSelected] = useState<ObjectSummary | null>(null);

  const gvk: GvkRef = {
    group: resource.group,
    version: resource.version,
    kind: resource.kind,
  };

  const q = useQuery({
    queryKey: ["objects", kindKey(resource), namespace],
    queryFn: () => api.listObjects(gvk, namespace || undefined),
    placeholderData: (prev) => prev,
  });

  const namespaces = useQuery({
    queryKey: ["namespaces"],
    queryFn: () => api.listNamespaces(),
    enabled: resource.namespaced,
  });

  const columns: Column<ObjectSummary>[] = [
    { key: "name", header: "Name", render: (o) => o.name },
    ...(resource.namespaced
      ? [
          {
            key: "namespace",
            header: "Namespace",
            render: (o: ObjectSummary) => o.namespace ?? "—",
          },
        ]
      : []),
    {
      key: "status",
      header: "Status",
      render: (o) =>
        o.status ? (
          <StatusDot tone={statusTone(o.status)} label={o.status} />
        ) : (
          <span className="text-content-muted">—</span>
        ),
    },
    { key: "age", header: "Age", render: (o) => o.age ?? "—", mono: true },
  ];

  if (selected) {
    return (
      <ObjectDetail
        resource={gvk}
        namespace={selected.namespace}
        name={selected.name}
        backTo={resource.kind}
        onClose={() => setSelected(null)}
      />
    );
  }

  return (
    <Panel
      title={resource.kind}
      subtitle={resource.group ? `${resource.group}/${resource.version}` : resource.version}
      error={q.error}
      isFetching={q.isFetching && !q.isLoading}
      onRefresh={() => q.refetch()}
      actions={
        <button
          onClick={onBack}
          className="rounded-sm border px-2 py-1 text-2xs text-content-secondary transition-colors duration-150 ease-swift hover:bg-content/[0.06] hover:text-content"
        >
          All kinds
        </button>
      }
    >
      <ResourceTable
        columns={columns}
        rows={q.data}
        isLoading={q.isLoading}
        rowKey={(o) => `${o.namespace ?? ""}/${o.name}`}
        searchText={(o) => `${o.name} ${o.namespace ?? ""} ${o.status ?? ""}`}
        empty={`No ${resource.plural} exist.`}
        onRowClick={setSelected}
        toolbar={
          resource.namespaced && (
            <Select value={namespace} onChange={setNamespace}>
              <option value="">All namespaces</option>
              {(namespaces.data ?? []).map((ns) => (
                <option key={ns.name} value={ns.name}>
                  {ns.name}
                </option>
              ))}
            </Select>
          )
        }
      />
    </Panel>
  );
}

export function CustomResources() {
  const [kind, setKind] = useState<ApiResourceInfo | null>(null);

  return kind ? (
    <Objects resource={kind} onBack={() => setKind(null)} />
  ) : (
    <Kinds onSelect={setKind} />
  );
}
