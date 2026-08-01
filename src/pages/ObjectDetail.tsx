import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { StatusDot } from "../components/StatusDot";
import { Chip } from "../components/Chip";
import { DetailShell, type TabSpec } from "../components/DetailShell";
import { EditableYaml } from "../components/EditableYaml";
import { EventsTable } from "../components/EventsTable";
import {
  Annotations,
  Field,
  PairChips,
  Section,
} from "../components/Field";
import { api, type GvkRef } from "../lib/api";
import { OverviewSkeleton } from "./PodDetail";

// Detail for an object of a kind we know nothing about at compile time.
//
// Everything specific to a kind lives in the YAML tab; the overview can
// only show what the API conventions promise — identity, labels, and
// whatever the object says about its own readiness.

/// Tones a status word without knowing the vocabulary.
///
/// CRDs invent their own, so this matches the shapes that recur across
/// them rather than an enumerated list, and stays neutral when unsure —
/// colouring an unrecognised word green would be a claim we cannot make.
///
/// Statuses arrive in camelCase ("ModelPullFailed", "CrashLoopBackOff"),
/// so the words are separated first. Without that, "Failed" inside a
/// reason is invisible to a word-boundary match and a failing object
/// renders as merely not-ready.
export function statusTone(status: string): "ok" | "warn" | "danger" | "unknown" {
  const words = status.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

  if (
    /\b(fail|failed|failing|failure|error|crash|lost|unhealthy|degraded|evicted|back\s?off)\b/.test(
      words,
    )
  ) {
    return "danger";
  }
  // Checked before the healthy words: separating the camelCase in
  // "NotReady" leaves a bare "ready" that would otherwise read green.
  if (/\b(not|un)\s*(ready|available|healthy|known)\b/.test(words)) return "warn";
  if (
    /\b(pending|progress|progressing|creating|updating|waiting|unknown|reconciling|terminating)\b/.test(
      words,
    )
  ) {
    return "warn";
  }
  if (
    /\b(ready|running|active|available|succeeded|healthy|deployed|bound|serving|synced)\b/.test(
      words,
    )
  ) {
    return "ok";
  }
  return "unknown";
}

interface ObjectDetailProps {
  resource: GvkRef;
  namespace: string | null;
  name: string;
  onClose: () => void;
  backTo?: string;
}

export function ObjectDetail({
  resource,
  namespace,
  name,
  onClose,
  backTo,
}: ObjectDetailProps) {
  const [tab, setTab] = useState("overview");
  const queryClient = useQueryClient();

  const key = ["object", resource.group, resource.version, resource.kind, namespace, name];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.getObject(resource, namespace, name),
  });
  const object = q.data;

  // A cluster-scoped object has no namespace to look for events in, and
  // guessing "default" would show somebody else's.
  const tabs: TabSpec[] = [
    { id: "overview", label: "Overview" },
    ...(namespace ? [{ id: "events", label: "Events" }] : []),
    { id: "yaml", label: "YAML" },
  ];

  return (
    <DetailShell
      title={name}
      subtitle={
        namespace ? `${resource.kind} · ${namespace}` : resource.kind
      }
      badge={
        object?.status && (
          <StatusDot tone={statusTone(object.status)} label={object.status} />
        )
      }
      tabs={tabs}
      tab={tab}
      onTab={setTab}
      onClose={onClose}
      backTo={backTo}
      error={q.error}
    >
      {tab === "overview" &&
        (object ? (
          <div className="h-full overflow-y-auto px-4 py-3">
            <dl>
              <Field label="Kind" value={object.kind} />
              <Field label="API version" value={object.apiVersion} />
              <Field label="Namespace" value={object.namespace} />
              <Field label="Status" value={object.status} />
              <Field label="Age" value={object.age} />
            </dl>

            {object.conditions.length > 0 && (
              <Section title="Conditions">
                <ul className="text-sm">
                  {object.conditions.map((c) => (
                    <li key={c.type} className="py-0.5">
                      <StatusDot
                        tone={c.status === "True" ? "ok" : "warn"}
                        label={`${c.type}: ${c.status}`}
                      />
                      {c.reason && (
                        <span className="ml-2">
                          <Chip tone="accent">{c.reason}</Chip>
                        </span>
                      )}
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

            <PairChips title="Labels" pairs={object.labels} />
            <Annotations pairs={object.annotations} />

            {!object.editable && (
              <p className="mt-4 text-2xs text-content-muted">
                This cluster does not accept updates to {object.kind}, so its
                YAML is read-only here.
              </p>
            )}
          </div>
        ) : (
          <OverviewSkeleton />
        ))}

      {tab === "events" && namespace && (
        <EventsTable namespace={namespace} name={name} />
      )}

      {tab === "yaml" &&
        (object ? (
          <EditableYaml
            source={object.yaml}
            // Read-only kinds get no editor rather than an Edit button
            // that always fails.
            target={
              object.editable
                ? {
                    apiVersion: object.apiVersion,
                    kind: object.kind,
                    namespace: object.namespace,
                    name: object.name,
                  }
                : null
            }
            onApplied={() => {
              queryClient.invalidateQueries({ queryKey: key });
              queryClient.invalidateQueries({ queryKey: ["objects"] });
            }}
          />
        ) : (
          <OverviewSkeleton />
        ))}
    </DetailShell>
  );
}
