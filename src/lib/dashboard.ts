import type { NodeRow, Overview, Problem, UsageAnswer } from "./api";
import { KIND_SECTIONS, type KindEntry } from "./kinds";
import { SEVERITY_RANK } from "./problems";

// What the dashboard does with a snapshot, as pure functions.
//
// The counting is done in Rust (`cluster::overview`), from the store the
// Problems monitor already keeps. What is left here is arithmetic for
// display — percentages, joining live usage onto nodes, which rows lead
// — kept out of the page so it can be tested without rendering one.

/// An overview with nothing in it: what a snapshot carries before any
/// watch has listed, and what fixtures build on.
export const EMPTY_OVERVIEW: Overview = {
  nodes: { total: 0, ready: 0, cordoned: 0 },
  pods: {
    total: 0,
    running: 0,
    pending: 0,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    crashLooping: 0,
  },
  workloads: ["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"].map((kind) => ({
    kind,
    total: 0,
    healthy: 0,
  })),
  capacity: {
    cpuAllocatable: 0,
    memoryAllocatable: 0,
    cpuRequested: 0,
    memoryRequested: 0,
    podsAllocatable: 0,
    podsScheduled: 0,
  },
  nodeRows: [],
  restarts: [],
  namespaces: [],
  namespaceCount: 0,
  claims: { total: 0, bound: 0, pending: 0, lost: 0 },
};

/// `part` of `whole` as a whole-number percentage, or null when there is
/// no whole to measure against — "0%" of nothing would be a claim.
export function percent(part: number, whole: number): number | null {
  if (!(whole > 0)) return null;
  return Math.round((part / whole) * 100);
}

/// How loud a utilisation figure should be. Utilisation is not a
/// status on its own — a full cluster is doing its job — so this only
/// speaks up near the ceiling, where new pods will stop scheduling.
export type Pressure = "normal" | "high" | "critical";

export function pressure(pct: number | null): Pressure {
  if (pct == null) return "normal";
  if (pct >= 95) return "critical";
  if (pct >= 85) return "high";
  return "normal";
}

/// Cores, the way `kubectl top` prints them: millicores under one core.
export function formatCores(cores: number): string {
  if (cores < 1) return `${Math.round(cores * 1000)}m`;
  return cores < 10 ? `${Number(cores.toFixed(1))}` : `${Math.round(cores)}`;
}

/// Bytes with the binary suffix that keeps them short.
export function formatBytes(bytes: number): string {
  const units: [string, number][] = [
    ["Ti", 1024 ** 4],
    ["Gi", 1024 ** 3],
    ["Mi", 1024 ** 2],
    ["Ki", 1024],
  ];
  for (const [suffix, size] of units) {
    if (bytes >= size) {
      const v = bytes / size;
      return `${v < 10 ? Number(v.toFixed(1)) : Math.round(v)}${suffix}`;
    }
  }
  return `${Math.round(bytes)}`;
}

/// A node with its live usage joined on, when metrics-server has it.
export interface NodeLoad extends NodeRow {
  cpuUsed: number | null;
  memoryUsed: number | null;
}

export function joinUsage(rows: NodeRow[], usage: UsageAnswer | undefined): NodeLoad[] {
  const byName = new Map(
    usage?.state === "available" ? usage.nodes.map((n) => [n.name, n]) : [],
  );
  return rows.map((row) => {
    const u = byName.get(row.name);
    return { ...row, cpuUsed: u?.cpu ?? null, memoryUsed: u?.memory ?? null };
  });
}

/// Cluster-wide usage, summed over the nodes that reported. Null when
/// none did. Measured against the allocatable of those same nodes: a
/// node metrics-server has not reached yet must not count as idle.
export function clusterUsage(nodes: NodeLoad[]): {
  cpuUsed: number;
  cpuAllocatable: number;
  memoryUsed: number;
  memoryAllocatable: number;
} | null {
  const reporting = nodes.filter((n) => n.cpuUsed != null && n.memoryUsed != null);
  if (reporting.length === 0) return null;
  return reporting.reduce(
    (acc, n) => ({
      cpuUsed: acc.cpuUsed + (n.cpuUsed ?? 0),
      cpuAllocatable: acc.cpuAllocatable + n.cpuAllocatable,
      memoryUsed: acc.memoryUsed + (n.memoryUsed ?? 0),
      memoryAllocatable: acc.memoryAllocatable + n.memoryAllocatable,
    }),
    { cpuUsed: 0, cpuAllocatable: 0, memoryUsed: 0, memoryAllocatable: 0 },
  );
}

/// How hard a node is working: the higher of its CPU and memory, by
/// usage when known and by requests otherwise. What the nodes widget
/// ranks on, so the node about to run out leads.
export function nodeLoad(n: NodeLoad): number {
  const cpu = percent(n.cpuUsed ?? n.cpuRequested, n.cpuAllocatable) ?? 0;
  const mem = percent(n.memoryUsed ?? n.memoryRequested, n.memoryAllocatable) ?? 0;
  return Math.max(cpu, mem);
}

/// Nodes that are not Ready come first whatever their load: a node
/// that is down is the one to look at.
export function busiestNodes(nodes: NodeLoad[], limit: number): NodeLoad[] {
  return [...nodes]
    .sort(
      (a, b) =>
        Number(a.ready) - Number(b.ready) ||
        nodeLoad(b) - nodeLoad(a) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit);
}

export interface ProblemTally {
  critical: number;
  warning: number;
}

/// Critical and warning rows. Info rows — "not permitted to list" — are
/// said where they apply, not counted as things wrong.
export function tallyProblems(problems: Problem[]): ProblemTally {
  return {
    critical: problems.filter((p) => p.severity === "critical").length,
    warning: problems.filter((p) => p.severity === "warning").length,
  };
}

/// The rows the Problems widget shows: worst first, info left out.
export function topProblems(problems: Problem[], limit: number): Problem[] {
  return problems
    .filter((p) => p.severity !== "info")
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, limit);
}

/// Long-running workloads — the ones with replicas to be short of.
/// Jobs and CronJobs are listed but not counted in the headline: a Job
/// that finished is not a workload being unhealthy.
const REPLICATED = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

export function workloadHealth(overview: Overview): { healthy: number; total: number } {
  return overview.workloads
    .filter((w) => REPLICATED.has(w.kind))
    .reduce(
      (acc, w) => ({ healthy: acc.healthy + w.healthy, total: acc.total + w.total }),
      { healthy: 0, total: 0 },
    );
}

/// The rail's entry for a workload kind, so a row opens its listing.
export function kindEntry(kind: string): KindEntry | null {
  for (const section of KIND_SECTIONS) {
    const match = section.items.find((e) => e.gvk.kind === kind);
    if (match) return match;
  }
  return null;
}
