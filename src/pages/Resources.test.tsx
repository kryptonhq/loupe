import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { Namespaces, Nodes, Pods } from "./Resources";
import { api, type NodeSummary, type PodSummary } from "../lib/api";

// The three built-in list views. Each is a table plus a detail view it
// swaps to, so what is worth covering is the columns an operator scans,
// and that clicking a row opens the right object.

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    Channel: class {
      onmessage?: (event: unknown) => void;
    },
    api: {
      ...actual.api,
      listNodes: vi.fn(),
      listNamespaces: vi.fn(),
      listPods: vi.fn(),
      getNode: vi.fn(),
      getNamespace: vi.fn(),
      getPod: vi.fn(),
      listPodsOnNode: vi.fn(),
      listEvents: vi.fn(),
    },
  };
});

const listNodes = vi.mocked(api.listNodes);
const listNamespaces = vi.mocked(api.listNamespaces);
const listPods = vi.mocked(api.listPods);
const getNode = vi.mocked(api.getNode);
const getPod = vi.mocked(api.getPod);

function pod(overrides: Partial<PodSummary> = {}): PodSummary {
  return {
    name: "web-abc",
    namespace: "prod",
    phase: "Running",
    node: "worker-1",
    ready: "1/1",
    restarts: 0,
    age: "3d",
    ...overrides,
  };
}

function node(overrides: Partial<NodeSummary> = {}): NodeSummary {
  return {
    name: "worker-1",
    ready: true,
    roles: ["worker"],
    version: "v1.33.1",
    age: "65d",
    ...overrides,
  };
}

function renderPage(page: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
  return userEvent.setup();
}

beforeEach(() => {
  vi.mocked(api.listEvents).mockResolvedValue([]);
  vi.mocked(api.listPodsOnNode).mockResolvedValue([]);

  listNodes.mockReset().mockResolvedValue([node()]);
  listNamespaces
    .mockReset()
    .mockResolvedValue([{ name: "prod", phase: "Active", age: "120d" }]);
  listPods.mockReset().mockResolvedValue([pod()]);

  getNode.mockReset();
  getPod.mockReset();
  vi.mocked(api.getNamespace).mockReset();
});

describe("Nodes", () => {
  it("lists nodes with their roles and readiness", async () => {
    renderPage(<Nodes />);
    expect(await screen.findByText("worker-1")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("worker")).toBeInTheDocument();
    expect(screen.getByText("v1.33.1")).toBeInTheDocument();
  });

  it("says NotReady rather than leaving the cell blank", async () => {
    listNodes.mockResolvedValue([node({ ready: false })]);
    renderPage(<Nodes />);
    expect(await screen.findByText("NotReady")).toBeInTheDocument();
  });

  it("renders an em dash for a node with no age", async () => {
    listNodes.mockResolvedValue([node({ age: null })]);
    renderPage(<Nodes />);
    expect(await screen.findByText("—")).toBeInTheDocument();
  });

  it("opens the node it was told to", async () => {
    getNode.mockImplementation(() => new Promise(() => {}));
    const user = renderPage(<Nodes />);
    await user.click(await screen.findByText("worker-1"));

    await waitFor(() => expect(getNode).toHaveBeenCalledWith("worker-1"));
  });

  it("surfaces a failure to list", async () => {
    listNodes.mockRejectedValue({
      kind: "kubernetes",
      message: 'nodes is forbidden: User "dev" cannot list resource "nodes"',
    });
    renderPage(<Nodes />);
    expect(await screen.findByText(/forbidden/)).toBeInTheDocument();
  });
});

describe("Namespaces", () => {
  it("lists namespaces with their phase", async () => {
    renderPage(<Namespaces />);
    expect(await screen.findByText("prod")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("opens the namespace it was told to", async () => {
    vi.mocked(api.getNamespace).mockImplementation(() => new Promise(() => {}));
    const user = renderPage(<Namespaces />);
    await user.click(await screen.findByText("prod"));

    await waitFor(() =>
      expect(api.getNamespace).toHaveBeenCalledWith("prod"),
    );
  });
});

describe("Pods", () => {
  it("shows the columns an operator scans", async () => {
    renderPage(<Pods />);
    expect(await screen.findByText("web-abc")).toBeInTheDocument();
    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(screen.getByText("worker-1")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("does not draw attention to a pod that has not restarted", async () => {
    // A coloured 0 on every healthy row would train people to ignore
    // the column that matters.
    renderPage(<Pods />);
    const zero = await screen.findByText("0");
    expect(zero).toHaveClass("text-content-muted");
  });

  it("escalates a heavily restarting pod", async () => {
    // Above five restarts the pod is not merely flapping; the column is
    // scanned for exactly this.
    listPods.mockResolvedValue([pod({ restarts: 12 })]);
    renderPage(<Pods />);
    expect(await screen.findByText("12")).toHaveClass("text-danger");
  });

  it("lists every namespace by default", async () => {
    // Matching `kubectl get pods -A`, which is what the cluster-wide
    // view is for.
    renderPage(<Pods />);
    await screen.findByText("web-abc");
    expect(listPods).toHaveBeenCalledWith(undefined);
    expect(screen.getByText("All namespaces")).toBeInTheDocument();
  });

  it("narrows to one namespace when picked", async () => {
    const user = renderPage(<Pods />);
    await screen.findByText("web-abc");

    await user.selectOptions(screen.getByRole("combobox"), "prod");
    await waitFor(() => expect(listPods).toHaveBeenCalledWith("prod"));
  });

  it("opens the pod it was told to, with its namespace", async () => {
    // A pod is identified by both. Opening on the name alone would find
    // the wrong pod wherever a name repeats across namespaces.
    getPod.mockImplementation(() => new Promise(() => {}));
    const user = renderPage(<Pods />);
    await user.click(await screen.findByText("web-abc"));

    await waitFor(() => expect(getPod).toHaveBeenCalledWith("prod", "web-abc"));
  });

  it("says so when nothing is visible", async () => {
    listPods.mockResolvedValue([]);
    renderPage(<Pods />);
    expect(await screen.findByText("No pods visible.")).toBeInTheDocument();
  });
});
