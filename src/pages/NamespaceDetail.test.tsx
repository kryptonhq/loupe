import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NamespaceDetail } from "./NamespaceDetail";
import { api, type NamespaceDetail as NamespaceDetailData } from "../lib/api";

// A Namespace object is almost empty — a phase and some finalizers. The
// questions people open one to answer are about its contents: how many
// pods are unhealthy, and whether a quota is why nothing new will start.

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getNamespace: vi.fn(),
      listPods: vi.fn(),
      listNamespaceEvents: vi.fn(),
    },
  };
});

const getNamespace = vi.mocked(api.getNamespace);
const listPods = vi.mocked(api.listPods);
const listNamespaceEvents = vi.mocked(api.listNamespaceEvents);

function namespace(
  overrides: Partial<NamespaceDetailData> = {},
): NamespaceDetailData {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    name: "prod",
    phase: "Active",
    age: "120d",
    labels: [],
    annotations: [],
    finalizers: [],
    podCount: 3,
    podsByPhase: [
      { phase: "Running", count: 2 },
      { phase: "Failed", count: 1 },
    ],
    quotas: [],
    yaml: "apiVersion: v1\nkind: Namespace\n",
    ...overrides,
  };
}

function renderDetail(onOpenPod?: () => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <NamespaceDetail name="prod" onClose={vi.fn()} onOpenPod={onOpenPod} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  getNamespace.mockReset();
  listPods.mockReset();
  listNamespaceEvents.mockReset();

  getNamespace.mockResolvedValue(namespace());
  listPods.mockResolvedValue([]);
  listNamespaceEvents.mockResolvedValue([]);
});

describe("NamespaceDetail", () => {
  it("breaks the pod count down by phase", async () => {
    // "3 pods" does not say whether anything is wrong; "1 Failed" does.
    renderDetail();
    expect(await screen.findByText("2 Running")).toBeInTheDocument();
    expect(screen.getByText("1 Failed")).toBeInTheDocument();
  });

  it("says None rather than showing an empty row for an empty namespace", async () => {
    getNamespace.mockResolvedValue(
      namespace({ podCount: 0, podsByPhase: [] }),
    );
    renderDetail();
    expect(await screen.findByText("None")).toBeInTheDocument();
  });

  it("counts one pod in the singular", async () => {
    getNamespace.mockResolvedValue(
      namespace({ podCount: 1, podsByPhase: [{ phase: "Running", count: 1 }] }),
    );
    renderDetail();
    expect(await screen.findByText("1 pod")).toBeInTheDocument();
  });

  it("names the finalizers holding up a deletion", async () => {
    // A namespace that will not go away is always a finalizer nobody is
    // answering for, and naming it is the entire diagnosis.
    getNamespace.mockResolvedValue(
      namespace({
        phase: "Terminating",
        finalizers: ["custom.io/cleanup"],
      }),
    );

    renderDetail();
    expect(await screen.findByText(/deletion is waiting on these/)).toBeInTheDocument();
    expect(screen.getByText("custom.io/cleanup")).toBeInTheDocument();
  });

  it("does not dramatise finalizers on a healthy namespace", async () => {
    // Every namespace has the `kubernetes` finalizer. Heading it with
    // "deletion is waiting" on an Active namespace would read as alarm.
    getNamespace.mockResolvedValue(
      namespace({ phase: "Active", finalizers: ["kubernetes"] }),
    );

    renderDetail();
    expect(await screen.findByText("Finalizers")).toBeInTheDocument();
    expect(
      screen.queryByText(/deletion is waiting on these/),
    ).not.toBeInTheDocument();
  });

  it("omits the finalizers section when there are none", async () => {
    renderDetail();
    await screen.findByText("2 Running");
    expect(screen.queryByText(/Finalizer/)).not.toBeInTheDocument();
  });

  it("lists the pods in this namespace alone", async () => {
    const user = renderDetail();
    await screen.findByText("2 Running");
    await user.click(screen.getByRole("button", { name: "Pods" }));

    expect(listPods).toHaveBeenCalledWith("prod");
  });

  it("shows everything happening in the namespace, not to it", async () => {
    // A namespace object almost never has events of its own, so
    // filtering by involvedObject here would render an empty tab.
    const user = renderDetail();
    await screen.findByText("2 Running");
    await user.click(screen.getByRole("button", { name: "Events" }));

    expect(listNamespaceEvents).toHaveBeenCalledWith("prod");
  });

  it("surfaces a failure to read the namespace", async () => {
    getNamespace.mockRejectedValue({
      kind: "kubernetes",
      message: 'namespaces "prod" is forbidden',
    });
    renderDetail();
    expect(await screen.findByText(/forbidden/)).toBeInTheDocument();
  });
});
