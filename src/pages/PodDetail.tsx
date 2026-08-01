import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LogViewer } from "../components/LogViewer";
import { StatusDot, phaseTone } from "../components/StatusDot";
import { ResourceTable } from "../components/ResourceTable";
import { type Column } from "../components/Table";
import { Chip, eventTone } from "../components/Chip";
import { SkeletonBlock } from "../components/Skeleton";
import { YamlView } from "../components/YamlView";
import {
  api,
  errorMessage,
  type ContainerView,
  type EventView,
} from "../lib/api";

type Tab = "overview" | "logs" | "events" | "yaml";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "logs", label: "Logs" },
  { id: "events", label: "Events" },
  { id: "yaml", label: "YAML" },
];

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2 py-1 text-sm">
      <dt className="w-36 shrink-0 text-slate-500 dark:text-slate-400">
        {label}
      </dt>
      <dd className="min-w-0 break-words">{value ?? "—"}</dd>
    </div>
  );
}

function Containers({
  title,
  containers,
}: {
  title: string;
  containers: ContainerView[];
}) {
  if (containers.length === 0) return null;
  return (
    <section className="mt-4">
      <h3 className="mb-1 text-sm font-semibold">{title}</h3>
      <ul className="divide-y divide-slate-200 rounded border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        {containers.map((c) => (
          <li key={c.name} className="px-3 py-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">{c.name}</span>
              <StatusDot
                tone={
                  c.ready ? "ok" : c.state.startsWith("Running") ? "warn" : "error"
                }
                label={c.state}
              />
            </div>
            <p className="mt-0.5 truncate font-mono text-xs text-slate-500 dark:text-slate-400">
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
                <Chip tone={c.restarts > 5 ? "error" : "neutral"}>
                  {c.restarts} restart{c.restarts === 1 ? "" : "s"}
                </Chip>
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Events({ namespace, name }: { namespace: string; name: string }) {
  const q = useQuery({
    queryKey: ["events", namespace, name],
    queryFn: () => api.listEvents(namespace, name),
  });

  const columns: Column<EventView>[] = [
    {
      key: "type",
      header: "Type",
      render: (e) => <Chip tone={eventTone(e.type)}>{e.type}</Chip>,
    },
    {
      key: "reason",
      header: "Reason",
      render: (e) => (e.reason ? <Chip tone="accent">{e.reason}</Chip> : "—"),
    },
    { key: "message", header: "Message", render: (e) => e.message ?? "—" },
    { key: "count", header: "Count", render: (e) => e.count ?? 1, mono: true },
    { key: "age", header: "Age", render: (e) => e.age ?? "—", mono: true },
  ];

  return (
    <>
      {q.error != null && (
        <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">
          {errorMessage(q.error)}
        </div>
      )}
      <ResourceTable
        columns={columns}
        rows={q.data}
        isLoading={q.isLoading}
        rowKey={(_, i) => String(i)}
        searchText={(e) => `${e.type} ${e.reason ?? ""} ${e.message ?? ""}`}
        empty="No events. Kubernetes discards them after about an hour."
      />
    </>
  );
}

interface PodDetailProps {
  namespace: string;
  name: string;
  onClose: () => void;
}

export function PodDetail({ namespace, name, onClose }: PodDetailProps) {
  const [tab, setTab] = useState<Tab>("overview");

  const q = useQuery({
    queryKey: ["pod", namespace, name],
    queryFn: () => api.getPod(namespace, name),
  });
  const pod = q.data;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <section className="flex h-full flex-col">
      <header className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="rounded px-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                title="Back to pods"
              >
                ←
              </button>
              <h2 className="truncate font-semibold">{name}</h2>
              {pod && (
                <StatusDot tone={phaseTone(pod.phase)} label={pod.phase} />
              )}
            </div>
            <p className="truncate pl-7 text-xs text-slate-500 dark:text-slate-400">
              {namespace}
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Close
          </button>
        </div>

        <nav className="mt-3 flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded px-2.5 py-1 text-sm transition-colors ${
                tab === t.id
                  ? "bg-accent text-accent-fg"
                  : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {q.error != null && (
        <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">
          {errorMessage(q.error)}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
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
                <section className="mt-4">
                  <h3 className="mb-1 text-sm font-semibold">Conditions</h3>
                  <ul className="text-sm">
                    {pod.conditions.map((c) => (
                      <li key={c.type} className="py-0.5">
                        <StatusDot
                          tone={c.status === "True" ? "ok" : "warn"}
                          label={`${c.type}: ${c.status}`}
                        />
                        {c.message && (
                          <span className="ml-2 text-slate-500 dark:text-slate-400">
                            {c.message}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {pod.labels.length > 0 && (
                <section className="mt-4">
                  <h3 className="mb-1 text-sm font-semibold">Labels</h3>
                  <div className="flex flex-wrap gap-1">
                    {pod.labels.map(([k, v]) => (
                      <Chip key={k} mono title={`${k}=${v}`}>
                        {k}={v}
                      </Chip>
                    ))}
                  </div>
                </section>
              )}
            </div>
          ) : (
            <div className="space-y-2 px-4 py-4">
              <SkeletonBlock className="h-3 w-64" />
              <SkeletonBlock className="h-3 w-48" />
              <SkeletonBlock className="h-3 w-56" />
              <SkeletonBlock className="h-24 w-full" />
            </div>
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

        {tab === "events" && (
          <Events namespace={namespace} name={name} />
        )}

        {tab === "yaml" &&
          (pod ? (
            <YamlView source={pod.yaml} />
          ) : (
            <div className="px-4 py-4">
              <SkeletonBlock className="h-64 w-full" />
            </div>
          ))}
      </div>
    </section>
  );
}
