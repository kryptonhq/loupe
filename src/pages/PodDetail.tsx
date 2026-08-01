import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LogViewer } from "../components/LogViewer";
import { StatusDot, phaseTone } from "../components/StatusDot";
import { Chip } from "../components/Chip";
import { DetailShell, type TabSpec } from "../components/DetailShell";
import { EditableYaml } from "../components/EditableYaml";
import { EventsTable } from "../components/EventsTable";
import { Field, PairChips, Section } from "../components/Field";
import { SkeletonBlock } from "../components/Skeleton";
import { api, type ContainerView } from "../lib/api";

const TABS: TabSpec[] = [
  { id: "overview", label: "Overview" },
  { id: "logs", label: "Logs" },
  { id: "events", label: "Events" },
  { id: "yaml", label: "YAML" },
];

function Containers({
  title,
  containers,
}: {
  title: string;
  containers: ContainerView[];
}) {
  if (containers.length === 0) return null;
  return (
    <Section title={title}>
      <ul className="divide-y divide-hairline/[0.06] overflow-hidden rounded border">
        {containers.map((c) => (
          <li key={c.name} className="px-3 py-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">{c.name}</span>
              <StatusDot
                tone={
                  c.ready ? "ok" : c.state.startsWith("Running") ? "warn" : "danger"
                }
                label={c.state}
              />
            </div>
            <p className="mt-0.5 truncate font-mono text-2xs text-content-muted">
              {c.image}
            </p>
            {/* The previous state is what explains a CrashLoopBackOff:
                the container is Waiting now, but it was OOMKilled. */}
            {c.lastState && (
              <p className="mt-1">
                <Chip tone="warn">previously {c.lastState}</Chip>
              </p>
            )}
            {c.restarts > 0 && (
              <p className="mt-1">
                <Chip tone={c.restarts > 5 ? "danger" : "neutral"}>
                  {c.restarts} restart{c.restarts === 1 ? "" : "s"}
                </Chip>
              </p>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

interface PodDetailProps {
  namespace: string;
  name: string;
  onClose: () => void;
}

export function PodDetail({ namespace, name, onClose }: PodDetailProps) {
  const [tab, setTab] = useState("overview");
  const queryClient = useQueryClient();

  const q = useQuery({
    queryKey: ["pod", namespace, name],
    queryFn: () => api.getPod(namespace, name),
  });
  const pod = q.data;

  return (
    <DetailShell
      title={name}
      subtitle={namespace}
      badge={pod && <StatusDot tone={phaseTone(pod.phase)} label={pod.phase} />}
      tabs={TABS}
      tab={tab}
      onTab={setTab}
      onClose={onClose}
      backTo="pods"
      error={q.error}
    >
      {tab === "overview" &&
        (pod ? (
          <div className="h-full overflow-y-auto px-4 py-3">
            <dl>
              <Field label="Node" value={pod.node} />
              <Field label="Pod IP" value={pod.podIp} />
              <Field label="Service account" value={pod.serviceAccount} />
              <Field label="QoS class" value={pod.qosClass} />
              <Field label="Age" value={pod.age} />
            </dl>

            <Containers title="Init containers" containers={pod.initContainers} />
            <Containers title="Containers" containers={pod.containers} />

            {pod.conditions.length > 0 && (
              <Section title="Conditions">
                <ul className="text-sm">
                  {pod.conditions.map((c) => (
                    <li key={c.type} className="py-0.5">
                      <StatusDot
                        tone={c.status === "True" ? "ok" : "warn"}
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

            <PairChips title="Labels" pairs={pod.labels} />
          </div>
        ) : (
          <OverviewSkeleton />
        ))}

      {tab === "logs" &&
        (pod ? (
          <LogViewer
            namespace={namespace}
            pod={name}
            containers={[...pod.initContainers, ...pod.containers]}
          />
        ) : (
          <div className="px-4 py-4">
            <SkeletonBlock className="h-64 w-full" />
          </div>
        ))}

      {tab === "events" && <EventsTable namespace={namespace} name={name} />}

      {tab === "yaml" &&
        (pod ? (
          <EditableYaml
            source={pod.yaml}
            target={{
              apiVersion: pod.apiVersion,
              kind: pod.kind,
              namespace: pod.namespace,
              name: pod.name,
            }}
            // Most of a pod's spec is immutable, so an edit that lands
            // usually changes labels or annotations — which the overview
            // shows, hence the full refetch rather than a local swap.
            onApplied={() => {
              queryClient.invalidateQueries({
                queryKey: ["pod", namespace, name],
              });
              queryClient.invalidateQueries({ queryKey: ["pods"] });
            }}
          />
        ) : (
          <div className="px-4 py-4">
            <SkeletonBlock className="h-64 w-full" />
          </div>
        ))}
    </DetailShell>
  );
}

export function OverviewSkeleton() {
  return (
    <div className="space-y-2 px-4 py-4">
      <SkeletonBlock className="h-3 w-64" />
      <SkeletonBlock className="h-3 w-48" />
      <SkeletonBlock className="h-3 w-56" />
      <SkeletonBlock className="h-24 w-full" />
    </div>
  );
}
