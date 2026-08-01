import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Panel } from "../components/Panel";
import { ResourceTable } from "../components/ResourceTable";
import { type Column } from "../components/Table";
import { Chip } from "../components/Chip";
import { Select } from "../components/Select";
import { StatusDot, type Tone } from "../components/StatusDot";
import { DetailShell, type TabSpec } from "../components/DetailShell";
import { Field, Section } from "../components/Field";
import { YamlView } from "../components/YamlView";
import { Table } from "../components/Table";
import { OverviewSkeleton } from "./PodDetail";
import {
  api,
  type ReleaseRevision,
  type ReleaseSummary,
} from "../lib/api";

// Helm releases, read out of the release Secrets rather than the CLI.
//
// Deliberately read-only: install, upgrade and rollback are writes with
// consequences far beyond one object, and they belong behind a
// confirmation this release does not have yet.

/// Helm's status vocabulary is small and fixed, unlike a CRD's.
export function releaseTone(status: string): Tone {
  switch (status) {
    case "deployed":
      return "ok";
    case "failed":
      return "danger";
    case "pending-install":
    case "pending-upgrade":
    case "pending-rollback":
    case "uninstalling":
      return "warn";
    case "superseded":
    case "uninstalled":
      return "unknown";
    default:
      return "unknown";
  }
}

const TABS: TabSpec[] = [
  { id: "overview", label: "Overview" },
  { id: "values", label: "Values" },
  { id: "manifest", label: "Manifest" },
  { id: "notes", label: "Notes" },
  { id: "history", label: "History" },
];

function ReleaseDetail({
  namespace,
  name,
  onClose,
}: {
  namespace: string;
  name: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState("overview");

  const q = useQuery({
    queryKey: ["helm-release", namespace, name],
    queryFn: () => api.getHelmRelease(namespace, name),
  });
  const release = q.data;

  const historyColumns: Column<ReleaseRevision>[] = [
    { key: "revision", header: "Rev", render: (r) => r.revision, mono: true },
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusDot tone={releaseTone(r.status)} label={r.status} />,
    },
    { key: "chart", header: "Chart", render: (r) => r.chart },
    { key: "appVersion", header: "App version", render: (r) => r.appVersion ?? "—" },
    { key: "updated", header: "Updated", render: (r) => r.updated ?? "—", mono: true },
    {
      key: "description",
      header: "Description",
      render: (r) => r.description ?? "—",
    },
  ];

  return (
    <DetailShell
      title={name}
      subtitle={release ? `${release.chart} · ${namespace}` : namespace}
      badge={
        release && (
          <span className="flex items-center gap-2">
            <StatusDot
              tone={releaseTone(release.status)}
              label={release.status}
            />
            <Chip tone="neutral">rev {release.revision}</Chip>
          </span>
        )
      }
      tabs={TABS}
      tab={tab}
      onTab={setTab}
      onClose={onClose}
      backTo="releases"
      error={q.error}
    >
      {!release && <OverviewSkeleton />}

      {release && tab === "overview" && (
        <div className="h-full overflow-y-auto px-4 py-3">
          <dl>
            <Field label="Chart" value={release.chartName} />
            <Field label="Chart version" value={release.chartVersion} />
            <Field label="App version" value={release.appVersion} />
            <Field label="Revision" value={release.revision} />
            <Field label="Status" value={release.status} />
            <Field label="Last deployed" value={release.updated} />
            <Field label="First deployed" value={release.firstDeployed} />
            <Field label="Description" value={release.description} />
            <Field
              label="Home"
              value={
                release.home && (
                  <span className="break-all font-mono text-2xs">
                    {release.home}
                  </span>
                )
              }
            />
          </dl>

          {release.chartDescription && (
            <Section title="About this chart">
              <p className="text-sm text-content-secondary">
                {release.chartDescription}
              </p>
            </Section>
          )}
        </div>
      )}

      {release && tab === "values" &&
        (release.values ? (
          <YamlView source={release.values} />
        ) : (
          <p className="px-4 py-12 text-center text-sm text-content-muted">
            No values were overridden — this release runs the chart's
            defaults.
          </p>
        ))}

      {release && tab === "manifest" && <YamlView source={release.manifest} />}

      {release && tab === "notes" &&
        (release.notes ? (
          // Notes are plain text with meaningful line breaks, not YAML.
          <pre className="h-full overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-[1.6]">
            {release.notes}
          </pre>
        ) : (
          <p className="px-4 py-12 text-center text-sm text-content-muted">
            This chart ships no notes.
          </p>
        ))}

      {release && tab === "history" && (
        <div className="h-full overflow-y-auto">
          <Table
            columns={historyColumns}
            rows={release.history}
            rowKey={(r) => String(r.revision)}
            empty="No revision history."
          />
        </div>
      )}
    </DetailShell>
  );
}

export function Helm() {
  const [namespace, setNamespace] = useState("");
  const [selected, setSelected] = useState<ReleaseSummary | null>(null);

  const q = useQuery({
    queryKey: ["helm-releases", namespace],
    queryFn: () => api.listHelmReleases(namespace || undefined),
    placeholderData: (prev) => prev,
  });

  const namespaces = useQuery({
    queryKey: ["namespaces"],
    queryFn: () => api.listNamespaces(),
  });

  const columns: Column<ReleaseSummary>[] = [
    { key: "name", header: "Name", render: (r) => r.name },
    { key: "namespace", header: "Namespace", render: (r) => r.namespace },
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusDot tone={releaseTone(r.status)} label={r.status} />,
    },
    { key: "chart", header: "Chart", render: (r) => r.chart },
    {
      key: "appVersion",
      header: "App version",
      render: (r) => r.appVersion ?? "—",
      mono: true,
    },
    { key: "revision", header: "Rev", render: (r) => r.revision, mono: true },
    {
      key: "updated",
      header: "Updated",
      render: (r) => r.updated ?? "—",
      mono: true,
    },
  ];

  if (selected) {
    return (
      <ReleaseDetail
        namespace={selected.namespace}
        name={selected.name}
        onClose={() => setSelected(null)}
      />
    );
  }

  return (
    <Panel
      title="Helm releases"
      subtitle="Read from the release secrets — no helm binary needed"
      error={q.error}
      isFetching={q.isFetching && !q.isLoading}
      onRefresh={() => q.refetch()}
    >
      <ResourceTable
        columns={columns}
        rows={q.data}
        isLoading={q.isLoading}
        rowKey={(r) => `${r.namespace}/${r.name}`}
        searchText={(r) => `${r.name} ${r.namespace} ${r.chart} ${r.status}`}
        empty="No Helm releases. Loupe reads the default secret driver; a cluster configured for the configmap or SQL backend keeps them elsewhere."
        onRowClick={setSelected}
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
