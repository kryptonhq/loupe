import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { StatusDot, phaseTone } from "../components/StatusDot";
import { Chip, ChipList } from "../components/Chip";
import { DetailShell, type TabSpec } from "../components/DetailShell";
import { EditableYaml } from "../components/EditableYaml";
import { EventsTable } from "../components/EventsTable";
import { Field, PairChips, QuantityRows, Section } from "../components/Field";
import { ResourceTable } from "../components/ResourceTable";
import { type Column } from "../components/Table";
import { api, type PodSummary, type ResourceUsage } from "../lib/api";
import { OverviewSkeleton } from "./PodDetail";

const TABS: TabSpec[] = [
  { id: "overview", label: "Overview" },
  { id: "pods", label: "Pods" },
  { id: "events", label: "Events" },
  { id: "yaml", label: "YAML" },
];

/// A node's headroom in one dimension, as a bar.
///
/// The bar exists because "850m of 12" is arithmetic and a filled
/// seventh is not — and headroom is the one thing on this page people
/// read at a glance rather than study.
function UsageBar({ usage }: { usage: ResourceUsage }) {
  const pct = usage.requestsPercent;
  const tone =
    pct === null
      ? "bg-content-muted"
      : pct >= 90
        ? "bg-danger"
        : pct >= 75
          ? "bg-warn"
          : "bg-success";

  return (
    <div className="py-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span>{usage.name}</span>
        <span className="font-mono text-2xs tabular-nums text-content-secondary">
          {usage.requests} / {usage.allocatable}
          {pct !== null && (
            <span className="ml-1.5 text-content-muted">({pct}%)</span>
          )}
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-content/[0.06]">
        <div
          className={`h-full rounded-full transition-all duration-300 ease-swift ${tone}`}
          // Over-committed nodes exist; the bar clamps so it cannot
          // overflow its track, and the percentage beside it still tells
          // the truth.
          style={{ width: `${Math.min(100, pct ?? 0)}%` }}
        />
      </div>
      <p className="mt-0.5 text-2xs text-content-muted">
        limits {usage.limits}
        {usage.limitsPercent !== null && ` (${usage.limitsPercent}%)`}
      </p>
    </div>
  );
}

function NodePods({ node }: { node: string }) {
  const q = useQuery({
    queryKey: ["node-pods", node],
    queryFn: () => api.listPodsOnNode(node),
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
      render: (p) => p.restarts,
      mono: true,
    },
    { key: "age", header: "Age", render: (p) => p.age ?? "—", mono: true },
  ];

  return (
    <ResourceTable
      columns={columns}
      rows={q.data}
      isLoading={q.isLoading}
      rowKey={(p) => `${p.namespace}/${p.name}`}
      searchText={(p) => `${p.name} ${p.namespace} ${p.phase}`}
      empty="Nothing is scheduled on this node."
    />
  );
}

interface NodeDetailProps {
  name: string;
  onClose: () => void;
}

export function NodeDetail({ name, onClose }: NodeDetailProps) {
  const [tab, setTab] = useState("overview");
  const queryClient = useQueryClient();

  const q = useQuery({
    queryKey: ["node", name],
    queryFn: () => api.getNode(name),
  });
  const node = q.data;

  return (
    <DetailShell
      title={name}
      subtitle={node ? `${node.version} · ${node.podCount} pods` : undefined}
      badge={
        node && (
          <span className="flex items-center gap-2">
            <StatusDot
              tone={node.ready ? "ok" : "danger"}
              label={node.ready ? "Ready" : "NotReady"}
            />
            {/* A cordoned node is still Ready, so the two have to be
                shown side by side or the page contradicts itself. */}
            {!node.schedulable && <Chip tone="warn">Cordoned</Chip>}
          </span>
        )
      }
      tabs={TABS}
      tab={tab}
      onTab={setTab}
      onClose={onClose}
      backTo="nodes"
      error={q.error}
    >
      {tab === "overview" &&
        (node ? (
          <div className="h-full overflow-y-auto px-4 py-3">
            <dl>
              <Field label="Roles" value={<ChipList values={node.roles} tone="accent" />} />
              <Field label="Kubelet" value={node.version} />
              <Field label="OS image" value={node.osImage} />
              <Field label="Kernel" value={node.kernelVersion} />
              <Field label="Container runtime" value={node.containerRuntime} />
              <Field
                label="Architecture"
                value={
                  node.architecture && node.operatingSystem
                    ? `${node.operatingSystem}/${node.architecture}`
                    : (node.architecture ?? node.operatingSystem)
                }
              />
              <Field label="Age" value={node.age} />
            </dl>

            <Section title="Allocated resources">
              <p className="mb-1 text-2xs text-content-muted">
                What scheduled pods have reserved, against what the
                scheduler has to give.
              </p>
              {node.allocated.map((u) => (
                <UsageBar key={u.name} usage={u} />
              ))}
            </Section>

            {node.taints.length > 0 && (
              <Section title="Taints">
                <ChipList values={node.taints} tone="warn" mono />
              </Section>
            )}

            {node.conditions.length > 0 && (
              <Section title="Conditions">
                <ul className="text-sm">
                  {node.conditions.map((c) => (
                    <li key={c.type} className="py-0.5">
                      <StatusDot
                        // Ready is healthy when True; every other node
                        // condition is a pressure signal, healthy when
                        // False. Treating them alike paints a working
                        // node red.
                        tone={
                          (c.type === "Ready") === (c.status === "True")
                            ? "ok"
                            : "warn"
                        }
                        label={`${c.type}: ${c.status}`}
                      />
                      {c.message && (
                        <span className="ml-2 text-content-muted">
                          {c.message}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <Section title="Addresses">
              <QuantityRows pairs={node.addresses} />
            </Section>

            <Section title="Capacity">
              <QuantityRows pairs={node.capacity} />
            </Section>

            <Section title="Allocatable">
              <QuantityRows pairs={node.allocatable} />
            </Section>

            <PairChips title="Labels" pairs={node.labels} />
          </div>
        ) : (
          <OverviewSkeleton />
        ))}

      {tab === "pods" && <NodePods node={name} />}

      {/* A node is cluster-scoped, but its events are recorded in
          "default" — that is where the kubelet writes them. */}
      {tab === "events" && <EventsTable namespace="default" name={name} />}

      {tab === "yaml" &&
        (node ? (
          <EditableYaml
            source={node.yaml}
            target={{
              apiVersion: node.apiVersion,
              kind: node.kind,
              namespace: null,
              name: node.name,
            }}
            onApplied={() => {
              queryClient.invalidateQueries({ queryKey: ["node", name] });
              queryClient.invalidateQueries({ queryKey: ["nodes"] });
            }}
          />
        ) : (
          <OverviewSkeleton />
        ))}
    </DetailShell>
  );
}
