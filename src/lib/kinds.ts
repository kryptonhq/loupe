import type { GvkRef } from "./api";

// The kinds the sidebar offers, and how they are grouped.
//
// This is a curated list, not everything the cluster serves — the rail
// is for the objects people reach for daily, and the CRDs page can list
// the other sixty. What belongs here is the set you would name if asked
// to describe a running application: what it is (workloads), how it is
// reached (network), what configures it (config), and what it stores
// (storage).
//
// Nodes, Namespaces and Pods are absent because they have their own
// views with more than a table behind them — allocation bars, quota
// headroom, log streaming.

export interface KindEntry {
  /// Stable id, used for routing and as a query key.
  id: string;
  label: string;
  gvk: GvkRef;
}

export interface KindSection {
  title: string;
  items: KindEntry[];
}

function entry(label: string, group: string, version: string, kind: string): KindEntry {
  return { id: `${group}/${version}/${kind}`, label, gvk: { group, version, kind } };
}

export const KIND_SECTIONS: KindSection[] = [
  {
    title: "Workloads",
    items: [
      entry("Deployments", "apps", "v1", "Deployment"),
      entry("StatefulSets", "apps", "v1", "StatefulSet"),
      entry("DaemonSets", "apps", "v1", "DaemonSet"),
      entry("ReplicaSets", "apps", "v1", "ReplicaSet"),
      entry("Jobs", "batch", "v1", "Job"),
      entry("CronJobs", "batch", "v1", "CronJob"),
    ],
  },
  {
    title: "Network",
    items: [
      entry("Services", "", "v1", "Service"),
      entry("Ingresses", "networking.k8s.io", "v1", "Ingress"),
      entry("Network policies", "networking.k8s.io", "v1", "NetworkPolicy"),
    ],
  },
  {
    title: "Config",
    items: [
      entry("Config maps", "", "v1", "ConfigMap"),
      entry("Secrets", "", "v1", "Secret"),
      entry("Service accounts", "", "v1", "ServiceAccount"),
    ],
  },
  {
    title: "Storage",
    items: [
      entry("Volume claims", "", "v1", "PersistentVolumeClaim"),
      entry("Volumes", "", "v1", "PersistentVolume"),
      entry("Storage classes", "storage.k8s.io", "v1", "StorageClass"),
    ],
  },
];

/// Whether a kind holds a key/value map worth its own tab.
export function hasDataTab(kind: string, apiVersion: string): "config" | "secret" | null {
  if (apiVersion !== "v1") return null;
  if (kind === "ConfigMap") return "config";
  if (kind === "Secret") return "secret";
  return null;
}

/// Kinds whose pods a merged log view can stream.
///
/// A short list rather than "anything with a selector": a Service also
/// has one, and offering Logs on a Service would promise something the
/// tab does not do — it streams pods, not traffic.
const LOGGABLE_WORKLOADS = new Set([
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "ReplicaSet",
  "Job",
]);

/// The label selector a workload's pods carry, read out of its YAML.
///
/// Read from the text rather than from a parsed document because the
/// detail payload already carries the YAML and nothing else needs a
/// parser. Returns the API server's own selector syntax — `a=b,c=d` —
/// which is what the merged log command expects.
///
/// Only `matchLabels` is read. `matchExpressions` is deliberately not
/// translated: a selector that is nearly right would stream the wrong
/// pods, and streaming none is a much better failure than that.
export function workloadSelector(kind: string, yaml: string): string | null {
  if (!LOGGABLE_WORKLOADS.has(kind)) return null;

  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => /^\s{2}selector:\s*$/.test(l));
  if (start < 0) return null;

  const match = lines.findIndex(
    (l, i) => i > start && /^\s{4}matchLabels:\s*$/.test(l),
  );
  if (match < 0 || match > start + 3) return null;

  const pairs: string[] = [];
  for (let i = match + 1; i < lines.length; i += 1) {
    const found = /^\s{6}([^:\s]+):\s*"?([^"\n]*?)"?\s*$/.exec(lines[i]);
    if (!found) break;
    pairs.push(`${found[1]}=${found[2]}`);
  }

  return pairs.length ? pairs.join(",") : null;
}

/// Container ports declared in a manifest, offered as the sensible
/// choices when starting a forward.
///
/// Read from the YAML the detail payload already carries. Duplicates are
/// dropped and the order is kept, because the first port declared is
/// almost always the one anyone wants.
export function containerPorts(yaml: string): number[] {
  const found: number[] = [];
  for (const line of yaml.split("\n")) {
    const match = /^\s*(?:-\s*)?(?:containerPort|port|targetPort):\s*(\d+)\s*$/.exec(line);
    if (!match) continue;
    const port = Number(match[1]);
    if (port > 0 && port < 65536 && !found.includes(port)) found.push(port);
  }
  return found;
}
