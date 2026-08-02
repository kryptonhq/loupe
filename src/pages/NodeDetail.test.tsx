import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NodeDetail } from "./NodeDetail";
import { api, type NodeDetail as NodeDetailData } from "../lib/api";

// The page that answers "why will nothing schedule here". The three
// answers are a taint, a pressure condition, and requests that have
// already claimed the allocatable CPU — so those are what is asserted.

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getNode: vi.fn(),
      listPodsOnNode: vi.fn(),
      listEvents: vi.fn(),
    },
  };
});

const getNode = vi.mocked(api.getNode);
const listPodsOnNode = vi.mocked(api.listPodsOnNode);
const listEvents = vi.mocked(api.listEvents);

function node(overrides: Partial<NodeDetailData> = {}): NodeDetailData {
  return {
    apiVersion: "v1",
    kind: "Node",
    name: "worker-1",
    ready: true,
    schedulable: true,
    roles: ["worker"],
    version: "v1.33.1",
    age: "65d",
    addresses: [["InternalIP", "10.0.0.4"]],
    osImage: "Debian GNU/Linux 12",
    kernelVersion: "6.1.0",
    containerRuntime: "containerd://2.0.0",
    architecture: "arm64",
    operatingSystem: "linux",
    capacity: [["cpu", "8"]],
    allocatable: [["cpu", "7800m"]],
    allocated: [
      {
        name: "CPU",
        requests: "4",
        requestsPercent: 51,
        limits: "6",
        limitsPercent: 76,
        allocatable: "7800m",
      },
    ],
    taints: [],
    conditions: [],
    labels: [],
    annotations: [],
    podCount: 12,
    yaml: "apiVersion: v1\nkind: Node\n",
    ...overrides,
  };
}

function renderDetail() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <NodeDetail name="worker-1" onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  getNode.mockReset();
  listPodsOnNode.mockReset();
  listEvents.mockReset();

  getNode.mockResolvedValue(node());
  listPodsOnNode.mockResolvedValue([]);
  listEvents.mockResolvedValue([]);
});

describe("NodeDetail", () => {
  it("shows the machine's identity", async () => {
    renderDetail();
    expect(await screen.findByText("v1.33.1")).toBeInTheDocument();
    expect(screen.getByText("Debian GNU/Linux 12")).toBeInTheDocument();
    expect(screen.getByText("containerd://2.0.0")).toBeInTheDocument();
    expect(screen.getByText("linux/arm64")).toBeInTheDocument();
  });

  it("shows Ready and Cordoned side by side", async () => {
    // A cordoned node is still Ready. Showing only one of them makes the
    // page contradict either itself or the reason nothing is landing.
    getNode.mockResolvedValue(node({ ready: true, schedulable: false }));
    renderDetail();

    expect(await screen.findByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Cordoned")).toBeInTheDocument();
  });

  it("says nothing about cordoning when the node is schedulable", async () => {
    renderDetail();
    await screen.findByText("Ready");
    expect(screen.queryByText("Cordoned")).not.toBeInTheDocument();
  });

  it("shows taints, which are usually the answer", async () => {
    getNode.mockResolvedValue(
      node({ taints: ["dedicated=gpu:NoSchedule", "node.kubernetes.io/unreachable:NoExecute"] }),
    );
    renderDetail();

    expect(await screen.findByText("Taints")).toBeInTheDocument();
    expect(screen.getByText("dedicated=gpu:NoSchedule")).toBeInTheDocument();
  });

  it("omits the taints section on an untainted node", async () => {
    renderDetail();
    await screen.findByText("v1.33.1");
    expect(screen.queryByText("Taints")).not.toBeInTheDocument();
  });

  it("does not paint a healthy node red over its pressure conditions", async () => {
    // Ready is healthy when True; every other node condition is a
    // pressure signal and is healthy when False. Treating them alike
    // would show a working node as four warnings.
    getNode.mockResolvedValue(
      node({
        conditions: [
          { type: "Ready", status: "True", reason: "KubeletReady", message: null },
          { type: "MemoryPressure", status: "False", reason: null, message: null },
          { type: "DiskPressure", status: "False", reason: null, message: null },
        ],
      }),
    );

    renderDetail();
    expect(await screen.findByText("Ready: True")).toBeInTheDocument();
    expect(screen.getByText("MemoryPressure: False")).toBeInTheDocument();
  });

  it("shows the message on a condition that has tripped", async () => {
    getNode.mockResolvedValue(
      node({
        conditions: [
          {
            type: "MemoryPressure",
            status: "True",
            reason: "KubeletHasInsufficientMemory",
            message: "kubelet has insufficient memory available",
          },
        ],
      }),
    );

    renderDetail();
    expect(
      await screen.findByText(/insufficient memory available/),
    ).toBeInTheDocument();
  });

  it("measures allocation against allocatable, not capacity", async () => {
    // The kubelet reserves part of the machine for itself. Showing
    // capacity here would flatter every node.
    renderDetail();
    expect(await screen.findByText("Allocated resources")).toBeInTheDocument();
    expect(screen.getByText(/scheduler has to give/)).toBeInTheDocument();
    expect(screen.getByText("7800m")).toBeInTheDocument();
  });

  it("lists the pods scheduled onto this node, not the whole cluster", async () => {
    // The difference on a real cluster is thirty rows versus thirty
    // thousand, and it is filtered server-side.
    const user = renderDetail();
    await screen.findByText("v1.33.1");
    await user.click(screen.getByRole("button", { name: "Pods" }));

    expect(listPodsOnNode).toHaveBeenCalledWith("worker-1");
  });

  it("looks for a node's events in the default namespace", async () => {
    // A node is cluster-scoped, but the kubelet writes its events into
    // "default". Filtering on the node's own (absent) namespace would
    // show an empty tab on every node.
    const user = renderDetail();
    await screen.findByText("v1.33.1");
    await user.click(screen.getByRole("button", { name: "Events" }));

    expect(listEvents).toHaveBeenCalledWith("default", "worker-1");
  });

  it("surfaces a failure to read the node", async () => {
    getNode.mockRejectedValue({
      kind: "kubernetes",
      message: 'nodes "worker-1" not found',
    });
    renderDetail();
    expect(await screen.findByText(/not found/)).toBeInTheDocument();
  });
});
