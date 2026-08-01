import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { StatusDot, phaseTone } from "../components/StatusDot";
import { Chip, ChipList } from "../components/Chip";
import { DetailShell, type TabSpec } from "../components/DetailShell";
import { EditableYaml } from "../components/EditableYaml";
import { EventsTable } from "../components/EventsTable";
import {
  Annotations,
  Field,
  PairChips,
  Section,
} from "../components/Field";
import { ResourceTable } from "../components/ResourceTable";
import { type Column } from "../components/Table";
import { api, type PodSummary, type QuotaEntry } from "../lib/api";
import { OverviewSkeleton } from "./PodDetail";

const TABS: TabSpec[] = [
  { id: "overview", label: "Overview" },
  { id: "pods", label: "Pods" },
  { id: "events", label: "Events" },
  { id: "yaml", label: "YAML" },
];

function NamespacePods({
  namespace,
  onOpenPod,
}: {
  namespace: string;
  onOpenPod?: (pod: PodSummary) => void;
}) {
  const q = useQuery({
    queryKey: ["pods", namespace],
    queryFn: () => api.listPods(namespace),
  });

  const columns: Column<PodSummary>[] = [
    { key: "name", header: "Name", render: (p) => p.name },
    {
      key: "phase",
      header: "Status",
      render: (p) => <StatusDot tone={phaseTone(p.phase)} label={p.phase} />,
    },
    { key: "ready", header: "Ready", render: (p) => p.ready, mono: true },
    {
      key: "restarts",
      header: "Restarts",
      render: (p) => p.restarts,
      mono: true,
    },
    { key: "node", header: "Node", render: (p) => p.node ?? "—" },
    { key: "age", header: "Age", render: (p) => p.age ?? "—", mono: true },
  ];

  return (
    <ResourceTable
      columns={columns}
      rows={q.data}
      isLoading={q.isLoading}
      rowKey={(p) => p.name}
      searchText={(p) => `${p.name} ${p.phase} ${p.node ?? ""}`}
      empty="No pods in this namespace."
      onRowClick={onOpenPod}
    />
  );
}

function Quota({ entries }: { entries: QuotaEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-content-muted">No limits set.</p>;
  }
  return (
    <dl className="grid grid-cols-[minmax(0,14rem)_1fr] gap-x-3 text-sm">
      {entries.map((e) => (
        <div key={e.resource} className="contents">
          <dt className="truncate py-0.5 font-mono text-2xs text-content-muted">
            {e.resource}
          </dt>
          <dd className="py-0.5 font-mono text-2xs tabular-nums">
            {e.used} <span className="text-content-muted">of</span> {e.hard}
          </dd>
        </div>
      ))}
    </dl>
  );
}

interface NamespaceDetailProps {
  name: string;
  onClose: () => void;
  /// Opening a pod from here jumps to the Pods view, so the caller
  /// decides what that means rather than this page nesting a detail
  /// inside a detail.
  onOpenPod?: (pod: PodSummary) => void;
}

export function NamespaceDetail({
  name,
  onClose,
  onOpenPod,
}: NamespaceDetailProps) {
  const [tab, setTab] = useState("overview");
  const queryClient = useQueryClient();

  const q = useQuery({
    queryKey: ["namespace", name],
    queryFn: () => api.getNamespace(name),
  });
  const ns = q.data;

  return (
    <DetailShell
      title={name}
      subtitle={ns ? `${ns.podCount} pod${ns.podCount === 1 ? "" : "s"}` : undefined}
      badge={
        ns && (
          <StatusDot
            tone={ns.phase === "Active" ? "ok" : "warn"}
            label={ns.phase}
          />
        )
      }
      tabs={TABS}
      tab={tab}
      onTab={setTab}
      onClose={onClose}
      backTo="namespaces"
      error={q.error}
    >
      {tab === "overview" &&
        (ns ? (
          <div className="h-full overflow-y-auto px-4 py-3">
            <dl>
              <Field label="Status" value={ns.phase} />
              <Field label="Age" value={ns.age} />
              <Field
                label="Pods"
                value={
                  ns.podsByPhase.length === 0 ? (
                    "None"
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {ns.podsByPhase.map((t) => (
                        <Chip
                          key={t.phase}
                          tone={
                            t.phase === "Failed"
                              ? "danger"
                              : t.phase === "Pending"
                                ? "warn"
                                : t.phase === "Running"
                                  ? "ok"
                                  : "neutral"
                          }
                        >
                          {t.count} {t.phase}
                        </Chip>
                      ))}
                    </span>
                  )
                }
              />
            </dl>

            {/* Finalizers only matter when a namespace will not go away,
                and then they are the entire explanation. */}
            {ns.finalizers.length > 0 && (
              <Section
                title={
                  ns.phase === "Terminating"
                    ? "Finalizers — deletion is waiting on these"
                    : "Finalizers"
                }
              >
                <ChipList
                  values={ns.finalizers}
                  tone={ns.phase === "Terminating" ? "warn" : "neutral"}
                  mono
                />
              </Section>
            )}

            {ns.quotas.length > 0 &&
              ns.quotas.map((quota) => (
                <Section key={quota.name} title={`Quota: ${quota.name}`}>
                  <Quota entries={quota.entries} />
                </Section>
              ))}

            <PairChips title="Labels" pairs={ns.labels} />
            <Annotations pairs={ns.annotations} />
          </div>
        ) : (
          <OverviewSkeleton />
        ))}

      {tab === "pods" && (
        <NamespacePods namespace={name} onOpenPod={onOpenPod} />
      )}

      {/* Everything happening in the namespace, not to it — a Namespace
          object almost never has events of its own. */}
      {tab === "events" && <EventsTable namespace={name} />}

      {tab === "yaml" &&
        (ns ? (
          <EditableYaml
            source={ns.yaml}
            target={{
              apiVersion: ns.apiVersion,
              kind: ns.kind,
              namespace: null,
              name: ns.name,
            }}
            onApplied={() => {
              queryClient.invalidateQueries({ queryKey: ["namespace", name] });
              queryClient.invalidateQueries({ queryKey: ["namespaces"] });
            }}
          />
        ) : (
          <OverviewSkeleton />
        ))}
    </DetailShell>
  );
}
