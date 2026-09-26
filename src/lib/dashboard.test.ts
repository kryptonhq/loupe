import { describe, expect, it } from "vitest";
import type { NodeRow, Problem } from "./api";
import {
  EMPTY_OVERVIEW,
  busiestNodes,
  clusterUsage,
  formatBytes,
  formatCores,
  joinUsage,
  kindEntry,
  nodeLoad,
  percent,
  pressure,
  tallyProblems,
  topProblems,
  workloadHealth,
} from "./dashboard";

const GI = 1024 ** 3;

function row(name: string, overrides: Partial<NodeRow> = {}): NodeRow {
  return {
    name,
    ready: true,
    cordoned: false,
    cpuAllocatable: 4,
    memoryAllocatable: 8 * GI,
    cpuRequested: 1,
    memoryRequested: 2 * GI,
    pods: 3,
    ...overrides,
  };
}

function problem(id: string, severity: Problem["severity"]): Problem {
  return {
    id,
    severity,
    category: "pods",
    target: null,
    reason: "X",
    message: "x",
    since: null,
    count: null,
  };
}

describe("percent", () => {
  it("rounds to a whole number", () => {
    expect(percent(1, 3)).toBe(33);
    expect(percent(1.75, 6)).toBe(29);
  });

  it("says nothing rather than 0% when there is nothing to measure against", () => {
    expect(percent(0, 0)).toBeNull();
    expect(percent(5, 0)).toBeNull();
  });
});

describe("pressure", () => {
  it("only speaks up near the ceiling", () => {
    expect(pressure(null)).toBe("normal");
    expect(pressure(84)).toBe("normal");
    expect(pressure(85)).toBe("high");
    expect(pressure(95)).toBe("critical");
  });
});

describe("formatting", () => {
  it("prints cores the way kubectl top does", () => {
    expect(formatCores(0.25)).toBe("250m");
    expect(formatCores(1.5)).toBe("1.5");
    expect(formatCores(2)).toBe("2");
    expect(formatCores(48.4)).toBe("48");
  });

  it("prints bytes with a binary suffix", () => {
    expect(formatBytes(512)).toBe("512");
    expect(formatBytes(1536 * 1024)).toBe("1.5Mi");
    expect(formatBytes(8 * GI)).toBe("8Gi");
    expect(formatBytes(64 * GI)).toBe("64Gi");
  });
});

describe("joinUsage", () => {
  it("joins usage onto nodes by name", () => {
    const [a, b] = joinUsage([row("a"), row("b")], {
      state: "available",
      nodes: [{ name: "a", cpu: 2, memory: 4 * GI }],
    });
    expect(a.cpuUsed).toBe(2);
    // A node metrics-server has not reported yet has no usage, not zero.
    expect(b.cpuUsed).toBeNull();
  });

  it("leaves usage unknown when metrics-server is missing", () => {
    const [a] = joinUsage([row("a")], { state: "unavailable", reason: "nope" });
    expect(a.cpuUsed).toBeNull();
    expect(joinUsage([row("a")], undefined)[0].memoryUsed).toBeNull();
  });
});

describe("clusterUsage", () => {
  it("measures against only the nodes that reported", () => {
    // If the silent node's 4 cores counted, the cluster would look half
    // as busy as the nodes that reported actually are.
    const nodes = joinUsage([row("a"), row("b")], {
      state: "available",
      nodes: [{ name: "a", cpu: 2, memory: 4 * GI }],
    });
    expect(clusterUsage(nodes)).toEqual({
      cpuUsed: 2,
      cpuAllocatable: 4,
      memoryUsed: 4 * GI,
      memoryAllocatable: 8 * GI,
    });
  });

  it("is null when no node reported", () => {
    expect(clusterUsage(joinUsage([row("a")], undefined))).toBeNull();
  });
});

describe("busiestNodes", () => {
  it("ranks by the higher of CPU and memory, usage over requests", () => {
    const nodes = joinUsage(
      [row("idle"), row("hot-cpu"), row("hot-mem", { memoryRequested: 7 * GI })],
      { state: "available", nodes: [{ name: "hot-cpu", cpu: 3.8, memory: GI }] },
    );
    expect(nodeLoad(nodes[1])).toBe(95);
    expect(busiestNodes(nodes, 2).map((n) => n.name)).toEqual(["hot-cpu", "hot-mem"]);
  });

  it("puts a node that is down first whatever its load", () => {
    const nodes = joinUsage(
      [row("busy", { cpuRequested: 4 }), row("down", { ready: false, cpuRequested: 0 })],
      undefined,
    );
    expect(busiestNodes(nodes, 1)[0].name).toBe("down");
  });
});

describe("problems", () => {
  const rows = [
    problem("w", "warning"),
    problem("i", "info"),
    problem("c", "critical"),
    problem("w2", "warning"),
  ];

  it("counts critical and warning, and leaves info out", () => {
    expect(tallyProblems(rows)).toEqual({ critical: 1, warning: 2 });
  });

  it("leads with the worst and drops info rows", () => {
    expect(topProblems(rows, 2).map((p) => p.id)).toEqual(["c", "w"]);
  });
});

describe("workloadHealth", () => {
  it("counts the replicated kinds, not Jobs and CronJobs", () => {
    const overview = {
      ...EMPTY_OVERVIEW,
      workloads: [
        { kind: "Deployment", total: 10, healthy: 9 },
        { kind: "StatefulSet", total: 2, healthy: 2 },
        { kind: "DaemonSet", total: 3, healthy: 3 },
        { kind: "Job", total: 5, healthy: 1 },
        { kind: "CronJob", total: 1, healthy: 0 },
      ],
    };
    expect(workloadHealth(overview)).toEqual({ healthy: 14, total: 15 });
  });
});

describe("kindEntry", () => {
  it("finds the rail's entry for a workload kind", () => {
    expect(kindEntry("Deployment")?.label).toBe("Deployments");
    expect(kindEntry("CronJob")?.id).toBe("batch/v1/CronJob");
    expect(kindEntry("Nope")).toBeNull();
  });
});
