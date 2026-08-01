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
