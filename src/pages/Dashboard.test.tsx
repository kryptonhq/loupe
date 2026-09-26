import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Dashboard } from "./Dashboard";
import { api, type Problem, type ProblemsSnapshot, type UsageAnswer } from "../lib/api";
import { EMPTY_OVERVIEW } from "../lib/dashboard";
import { demoProblems, DEMO_USAGE } from "../dev/fixtures";
import type { ProblemsState } from "../lib/useProblems";

// The dashboard decides nothing about the cluster — the counts arrive in
// the Problems snapshot, computed in Rust. What matters here is that it
// shows them honestly (a source it could not read says so rather than
// showing zero; no metrics-server means "requested", not "in use"), and
// that every number is a way into the thing behind it.

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return { ...actual, api: { ...actual.api, nodeUsage: vi.fn() } };
});

const nodeUsage = vi.mocked(api.nodeUsage);

const CLUSTER = {
  context: "prod-eks",
  server: "https://example",
  version: "v1.31.2",
  platform: "linux/amd64",
};

const demo = () => demoProblems() as unknown as ProblemsSnapshot;

function state(snapshot: ProblemsSnapshot | null, error: string | null = null): ProblemsState {
  return { snapshot, receivedAt: Date.now(), error };
}

const GI = 1024 ** 3;

/// A small cluster with nothing wrong, running close to full — the
/// other side of every tone the demo exercises.
function healthy(): ProblemsSnapshot {
  return {
    ...demo(),
    problems: [],
    sources: demo().sources.map((s) => ({ source: s.source, category: s.category, state: "ready" })),
    overview: {
      ...EMPTY_OVERVIEW,
      nodes: { total: 3, ready: 3, cordoned: 0 },
      pods: { ...EMPTY_OVERVIEW.pods, total: 10, running: 9, succeeded: 1, crashLooping: 1 },
      workloads: EMPTY_OVERVIEW.workloads.map((w) => ({ ...w, total: 2, healthy: 2 })),
      capacity: {
        cpuAllocatable: 10,
        cpuRequested: 9,
        memoryAllocatable: 10 * GI,
        memoryRequested: 9.7 * GI,
        podsAllocatable: 330,
        podsScheduled: 9,
      },
      claims: { total: 2, bound: 2, pending: 0, lost: 0 },
    },
  };
}

function problem(overrides: Partial<Problem>): Problem {
  return {
    id: Math.random().toString(),
    severity: "warning",
    category: "nodes",
    target: null,
    reason: "Reason",
    message: "m",
    since: null,
    count: null,
    ...overrides,
  };
}

function setup(
  snapshot: ProblemsSnapshot | null = demo(),
  usage: UsageAnswer = DEMO_USAGE as UsageAnswer,
  cluster: typeof CLUSTER | null = CLUSTER,
) {
  nodeUsage.mockResolvedValue(usage);
  const open = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Dashboard state={state(snapshot)} cluster={cluster} open={open} />
    </QueryClientProvider>,
  );
  return { open, user: userEvent.setup() };
}

const card = (name: string | RegExp) => screen.getByRole("region", { name });
/// Titled by requests until usage arrives, and by usage after.
const nodesCard = () => card(/^Busiest nodes/);

beforeEach(() => {
  nodeUsage.mockReset();
});

describe("Dashboard", () => {
  it("says which cluster it is describing", () => {
    setup();
    expect(screen.getByText(/prod-eks · Kubernetes v1.31.2 · linux\/amd64/)).toBeInTheDocument();
  });

  it("shows placeholders until the first snapshot", () => {
    setup(null);
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
  });

  it("leads with nodes, pods, workloads and problems", () => {
    setup();
    const nodes = screen.getByRole("button", { name: /^Nodes/ });
    expect(nodes).toHaveTextContent("4/ 5");
    expect(nodes).toHaveTextContent("1 not ready · 1 cordoned");

    const pods = screen.getByRole("button", { name: /^Pods running/ });
    expect(pods).toHaveTextContent("118/ 131");
    expect(pods).toHaveTextContent("3 crash-looping · 4 pending · 2 failed");

    // Deployments, StatefulSets and DaemonSets: 39+5+6 of 42+6+7.
    expect(screen.getByRole("button", { name: /^Workloads healthy/ })).toHaveTextContent("50/ 55");
    expect(screen.getByRole("button", { name: /^Problems/ })).toHaveTextContent(
      "3 critical · 4 warning",
    );
  });

  it("measures CPU by live usage when metrics-server answers", async () => {
    setup();
    const cpu = card("CPU");
    await waitFor(() => expect(cpu).toHaveTextContent("in use"));
    expect(within(cpu).getByRole("meter", { name: "In use" })).toBeInTheDocument();
    expect(within(cpu).getByRole("meter", { name: "Requested" })).toBeInTheDocument();
  });

  it("falls back to requests, and says why, without metrics-server", async () => {
    setup(demo(), { state: "unavailable", reason: "metrics-server is not installed, so usage is unknown" });
    const memory = card("Memory");
    await waitFor(() => expect(memory).toHaveTextContent(/Live usage unavailable: metrics-server/));
    expect(memory).toHaveTextContent("requested");
    expect(within(memory).queryByRole("meter", { name: "In use" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Busiest nodes, by requests" })).toBeInTheDocument();
  });

  it("says a widget could not be read rather than showing zero", () => {
    // The whole point of degrading per source: a user who may not list
    // nodes still sees pods, and the node numbers admit they are unknown.
    const snapshot = demo();
    snapshot.sources = snapshot.sources.map((s) =>
      s.source === "nodes" ? { ...s, state: "forbidden", message: "no" } : s,
    );
    setup(snapshot);
    expect(screen.getByRole("button", { name: /^Nodes/ })).toHaveTextContent("Not permitted to list nodes");
    expect(nodesCard()).toHaveTextContent("Not permitted to list nodes, so this is unknown.");
    expect(card("CPU")).toHaveTextContent("unknown");
  });

  it("names what each kind's unhealthy ones are", () => {
    setup();
    const workloads = card("Workloads");
    expect(within(workloads).getByRole("button", { name: /^Deployments/ })).toHaveTextContent("3 short");
    // A failed Job is not "short" of anything.
    expect(within(workloads).getByRole("button", { name: /^Jobs/ })).toHaveTextContent("1 failed");
    // The demo may not list CronJobs.
    expect(within(workloads).getByRole("button", { name: /^CronJobs/ })).toHaveTextContent(
      "Not permitted to list cronJobs",
    );
  });

  it("puts a node that is down first among the busiest", () => {
    setup();
    const rows = within(nodesCard()).getAllByRole("button", { name: /ip-10/ });
    expect(rows[0]).toHaveTextContent("ip-10-0-2-91");
    expect(rows[0]).toHaveTextContent("Not ready");
  });

  it("reads as healthy when nothing is wrong, and loud near the ceiling", async () => {
    setup(healthy(), { state: "unavailable", reason: "not installed" });
    expect(screen.getByTitle("Open Nodes")).toHaveTextContent("All ready");
    expect(screen.getByTitle("Open Workloads healthy")).toHaveTextContent(
      "Deployments, StatefulSets, DaemonSets",
    );
    expect(screen.getByTitle("Open Problems")).toHaveTextContent("Nothing wrong right now");
    // 90% of CPU requested is high; 97% of memory is near full.
    await waitFor(() => expect(card("CPU")).toHaveTextContent("High"));
    expect(card("Memory")).toHaveTextContent("Near full");
    expect(card("Pod phases")).toHaveTextContent("1 running pod is crash-looping");
    expect(within(card("Workloads")).getAllByText("ok")).toHaveLength(5);
  });

  it("lists a problem on a node without a namespace, with its count", () => {
    const snapshot = healthy();
    snapshot.problems = [
      problem({
        reason: "NodeNotReady",
        count: 3,
        target: { group: "", version: "v1", kind: "Node", namespace: null, name: "worker-2" },
      }),
      problem({ reason: "Orphaned", message: "no object behind this" }),
    ];
    setup(snapshot);
    const problems = card("Problems");
    expect(within(problems).getByText("Node worker-2")).toBeInTheDocument();
    expect(within(problems).getByText("×3")).toBeInTheDocument();
    // A row with nothing behind it cannot be opened.
    expect(within(problems).getByText("Orphaned").closest("button")).toBeDisabled();
  });

  it("names a workload kind it does not know by its API kind", () => {
    // A newer core may count a kind this build has no label for.
    const snapshot = healthy();
    snapshot.overview.workloads = [{ kind: "Rollout", total: 3, healthy: 1 }];
    setup(snapshot);
    const row = within(card("Workloads")).getByRole("button", { name: /^Rollout/ });
    expect(row).toHaveTextContent("2 unhealthy");
  });

  it("says a source that failed to list, and waits for one still listing", () => {
    const snapshot = demo();
    snapshot.sources = snapshot.sources.map((s) =>
      s.source === "persistentVolumeClaims"
        ? { ...s, state: "failed", message: "timeout" }
        : s.source === "pods"
          ? { source: s.source, category: s.category, state: "loading" }
          : s,
    );
    setup(snapshot);
    expect(card("Volume claims")).toHaveTextContent("Could not list persistentVolumeClaims");
    expect(within(card("CPU")).queryByRole("meter")).not.toBeInTheDocument();
  });

  it("marks every widget built on pods when pods are refused", () => {
    const snapshot = demo();
    snapshot.sources = snapshot.sources.map((s) =>
      s.source === "pods" ? { ...s, state: "forbidden", message: "no" } : s,
    );
    setup(snapshot);
    for (const name of ["Pod slots", "Pod phases", "Most restarts", "Namespaces by pods"]) {
      expect(card(name)).toHaveTextContent("Not permitted to list pods");
    }
  });

  it("still renders before a cluster is named", () => {
    setup(demo(), DEMO_USAGE as UsageAnswer, null);
    expect(screen.getByText("Cluster overview")).toBeInTheDocument();
  });

  it("shows empty states on an empty cluster", () => {
    setup({ ...demo(), problems: [], overview: EMPTY_OVERVIEW }, { state: "available", nodes: [] });
    expect(card("Problems")).toHaveTextContent("Nothing broken right now.");
    expect(card("Most restarts")).toHaveTextContent("No container has restarted.");
    expect(card("Volume claims")).toHaveTextContent("No persistent volume claims.");
    expect(card("Pod phases")).toHaveTextContent("No pods.");
    expect(card("Namespaces by pods")).toHaveTextContent("No pods in any namespace.");
    expect(nodesCard()).toHaveTextContent("No nodes.");
    // Nothing to measure yet is not "healthy": the tiles stay neutral.
    expect(screen.getByTitle("Open Nodes")).toHaveTextContent("0/ 0");
  });
});

describe("Dashboard as a way in", () => {
  it("opens each listing from its tile", async () => {
    const { open, user } = setup();
    await user.click(screen.getByRole("button", { name: /^Nodes/ }));
    expect(open).toHaveBeenLastCalledWith({ type: "nodes" }, "here");
    await user.click(screen.getByRole("button", { name: /^Pods running/ }));
    expect(open).toHaveBeenLastCalledWith({ type: "pods" }, "here");
    await user.click(screen.getByRole("button", { name: /^Problems/ }));
    expect(open).toHaveBeenLastCalledWith({ type: "problems" }, "here");
    await user.click(screen.getByRole("button", { name: /^Workloads healthy/ }));
    expect(open).toHaveBeenLastCalledWith(
      { type: "kind", entry: expect.objectContaining({ id: "apps/v1/Deployment" }) },
      "here",
    );
  });

  it("opens a tab of its own when ⌘ is held", async () => {
    const { open, user } = setup();
    await user.keyboard("{Meta>}");
    await user.click(screen.getByRole("button", { name: /^Nodes/ }));
    await user.keyboard("{/Meta}");
    expect(open).toHaveBeenLastCalledWith({ type: "nodes" }, "newTab");
  });

  it("opens the object behind a problem", async () => {
    const { open, user } = setup();
    await user.click(within(card("Problems")).getByText("CrashLoopBackOff"));
    expect(open).toHaveBeenLastCalledWith(
      { type: "pod", namespace: "shop", name: "checkout-7f9c-x2k" },
      "here",
    );
  });

  it("opens a namespace's pods, scoped to it", async () => {
    const { open, user } = setup();
    await user.click(screen.getByTitle("Pods in kube-system"));
    expect(open).toHaveBeenLastCalledWith(
      { type: "pods", view: { namespace: "kube-system" } },
      "here",
    );
  });

  it("opens the pod behind a restart, and the node behind a bar", async () => {
    const { open, user } = setup();
    await user.click(within(card("Most restarts")).getByText("trainer-0"));
    expect(open).toHaveBeenLastCalledWith({ type: "pod", namespace: "ml", name: "trainer-0" }, "here");

    await user.click(within(nodesCard()).getByText("ip-10-0-1-47"));
    expect(open).toHaveBeenLastCalledWith({ type: "node", name: "ip-10-0-1-47" }, "here");
  });

  it("opens a workload kind's listing from its row", async () => {
    const { open, user } = setup();
    await user.click(within(card("Workloads")).getByRole("button", { name: /^StatefulSets/ }));
    expect(open).toHaveBeenLastCalledWith(
      { type: "kind", entry: expect.objectContaining({ id: "apps/v1/StatefulSet" }) },
      "here",
    );
  });

  it("opens the full listings from each widget's link", async () => {
    const { open, user } = setup();
    await user.click(within(card("Problems")).getByRole("button", { name: /^All 7/ }));
    expect(open).toHaveBeenLastCalledWith({ type: "problems" }, "here");
    await user.click(within(card("Namespaces by pods")).getByRole("button", { name: "All 14 →" }));
    expect(open).toHaveBeenLastCalledWith({ type: "namespaces" }, "here");
    await user.click(within(card("Volume claims")).getByRole("button", { name: "All 23 →" }));
    expect(open).toHaveBeenLastCalledWith(
      { type: "kind", entry: expect.objectContaining({ id: "/v1/PersistentVolumeClaim" }) },
      "here",
    );
    await user.click(within(card("Pod phases")).getByRole("button", { name: "All pods →" }));
    expect(open).toHaveBeenLastCalledWith({ type: "pods" }, "here");
  });
});
