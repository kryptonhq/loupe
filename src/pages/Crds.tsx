import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Panel } from "../components/Panel";
import { ResourceTable } from "../components/ResourceTable";
import { type Column } from "../components/Table";
import { Chip } from "../components/Chip";
import { Select } from "../components/Select";
import { api, type ApiResourceInfo } from "../lib/api";
import type { KindEntry } from "../lib/kinds";

// Browsing anything the cluster serves, discovered at runtime.
//
// The sidebar lists the custom kinds directly, so most visits arrive
// here already knowing which one they want. This page is what you get
// when you do not: an index of every kind, including the built-ins,
// which the sidebar deliberately leaves out — seventy entries in a nav
// rail is not a nav rail.

/// Stable identity for a kind, used as a row key and a query key.
export function kindKey(r: ApiResourceInfo) {
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
      title="CRDs"
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

/// The index of every kind the cluster serves.
///
/// Selection is reported upward rather than held here: the sidebar picks
/// kinds too, and two owners of one selection drift apart the moment
/// either changes it.
export function Crds({
  onSelectKind,
}: {
  onSelectKind: (entry: KindEntry) => void;
}) {
  return (
    <Kinds
      onSelect={(resource) =>
        onSelectKind({
          id: kindKey(resource),
          label: resource.kind,
          gvk: {
            group: resource.group,
            version: resource.version,
            kind: resource.kind,
          },
        })
      }
    />
  );
}
