import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { Namespaces, Nodes, Pods } from "./Resources";
import { api, type NodeSummary, type PodSummary } from "../lib/api";

// The three built-in list views. Each is a listing and nothing else —
// what it does with a row is the workspace's business — so what is worth
// covering is the columns an operator scans, and that a click reports
// the right object and the right intent.

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
    },
  };
});

const listNodes = vi.mocked(api.listNodes);
const listNamespaces = vi.mocked(api.listNamespaces);
const listPods = vi.mocked(api.listPods);

const onOpen = vi.fn();
const onView = vi.fn();

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
  onOpen.mockReset();
  onView.mockReset();
  listNodes.mockReset().mockResolvedValue([node()]);
  listNamespaces
    .mockReset()
    .mockResolvedValue([{ name: "prod", phase: "Active", age: "120d" }]);
  listPods.mockReset().mockResolvedValue([pod()]);
});

describe("Nodes", () => {
  it("lists nodes with their roles and readiness", async () => {
    renderPage(<Nodes onOpen={onOpen} view={{}} onView={onView} />);
    expect(await screen.findByText("worker-1")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("worker")).toBeInTheDocument();
    expect(screen.getByText("v1.33.1")).toBeInTheDocument();
  });

  it("says NotReady rather than leaving the cell blank", async () => {
    listNodes.mockResolvedValue([node({ ready: false })]);
    renderPage(<Nodes onOpen={onOpen} view={{}} onView={onView} />);
    expect(await screen.findByText("NotReady")).toBeInTheDocument();
  });

  it("renders an em dash for a node with no age", async () => {
    listNodes.mockResolvedValue([node({ age: null })]);
    renderPage(<Nodes onOpen={onOpen} view={{}} onView={onView} />);
    expect(await screen.findByText("—")).toBeInTheDocument();
  });

  it("reports the node it was told to open", async () => {
    const user = renderPage(<Nodes onOpen={onOpen} view={{}} onView={onView} />);
    await user.click(await screen.findByText("worker-1"));

    await waitFor(() =>
      expect(onOpen).toHaveBeenCalledWith(
        expect.objectContaining({ name: "worker-1" }),
        "here",
      ),
    );
  });

  it("surfaces a failure to list", async () => {
    listNodes.mockRejectedValue({
      kind: "kubernetes",
      message: 'nodes is forbidden: User "dev" cannot list resource "nodes"',
    });
    renderPage(<Nodes onOpen={onOpen} view={{}} onView={onView} />);
    expect(await screen.findByText(/forbidden/)).toBeInTheDocument();
  });
});

describe("Namespaces", () => {
  it("lists namespaces with their phase", async () => {
    renderPage(<Namespaces onOpen={onOpen} view={{}} onView={onView} />);
    expect(await screen.findByText("prod")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("reports the namespace it was told to open", async () => {
    const user = renderPage(<Namespaces onOpen={onOpen} view={{}} onView={onView} />);
    await user.click(await screen.findByText("prod"));

    await waitFor(() =>
      expect(onOpen).toHaveBeenCalledWith(
        expect.objectContaining({ name: "prod" }),
        "here",
      ),
    );
  });
});

describe("Pods", () => {
  it("shows the columns an operator scans", async () => {
    renderPage(<Pods onOpen={onOpen} view={{}} onView={onView} />);
    expect(await screen.findByText("web-abc")).toBeInTheDocument();
    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(screen.getByText("worker-1")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("does not draw attention to a pod that has not restarted", async () => {
    // A coloured 0 on every healthy row would train people to ignore
    // the column that matters.
    renderPage(<Pods onOpen={onOpen} view={{}} onView={onView} />);
    const zero = await screen.findByText("0");
    expect(zero).toHaveClass("text-content-muted");
  });

  it("escalates a heavily restarting pod", async () => {
    // Above five restarts the pod is not merely flapping; the column is
    // scanned for exactly this.
    listPods.mockResolvedValue([pod({ restarts: 12 })]);
    renderPage(<Pods onOpen={onOpen} view={{}} onView={onView} />);
    expect(await screen.findByText("12")).toHaveClass("text-danger");
  });

  it("lists every namespace by default", async () => {
    // Matching `kubectl get pods -A`, which is what the cluster-wide
    // view is for.
    renderPage(<Pods onOpen={onOpen} view={{}} onView={onView} />);
    await screen.findByText("web-abc");
    expect(listPods).toHaveBeenCalledWith(undefined);
    expect(screen.getByText("All namespaces")).toBeInTheDocument();
  });

  it("reports the namespace it was asked to narrow to", async () => {
    // The page reports; where that is kept is the workspace's business.
    // Holding it here is what used to make the filter evaporate the
    // moment you opened a pod from the list.
    const user = renderPage(<Pods onOpen={onOpen} view={{}} onView={onView} />);
    await screen.findByText("web-abc");

    await user.selectOptions(screen.getByRole("combobox"), "prod");
    await waitFor(() => expect(onView).toHaveBeenCalledWith({ namespace: "prod" }));
  });

  it("asks the cluster for the namespace the view names", async () => {
    renderPage(
      <Pods onOpen={onOpen} view={{ namespace: "prod" }} onView={onView} />,
    );
    await waitFor(() => expect(listPods).toHaveBeenCalledWith("prod"));
    // And the picker shows it, once the namespace list has arrived.
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("prod"));
  });

  it("reports the pod it was told to open, with its namespace", async () => {
    // A pod is identified by both. Opening on the name alone would find
    // the wrong pod wherever a name repeats across namespaces.
    const user = renderPage(<Pods onOpen={onOpen} view={{}} onView={onView} />);
    await user.click(await screen.findByText("web-abc"));

    await waitFor(() =>
      expect(onOpen).toHaveBeenCalledWith(
        expect.objectContaining({ name: "web-abc", namespace: "prod" }),
        "here",
      ),
    );
  });

  it("asks for a new tab when the row is opened with the modifier held", async () => {
    // The convention a link follows everywhere else, and what lets a
    // listing be fanned out without returning to it between each one.
    const user = renderPage(<Pods onOpen={onOpen} view={{}} onView={onView} />);
    const row = await screen.findByText("web-abc");
    await user.keyboard("{Meta>}");
    await user.click(row);
    await user.keyboard("{/Meta}");

    await waitFor(() =>
      expect(onOpen).toHaveBeenCalledWith(expect.anything(), "newTab"),
    );
  });

  it("says so when nothing is visible", async () => {
    listPods.mockResolvedValue([]);
    renderPage(<Pods onOpen={onOpen} view={{}} onView={onView} />);
    expect(await screen.findByText("No pods visible.")).toBeInTheDocument();
  });
});
