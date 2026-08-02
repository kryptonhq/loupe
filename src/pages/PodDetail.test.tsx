import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PodDetail } from "./PodDetail";
import { api, type ContainerView, type PodDetail as PodDetailData } from "../lib/api";

// The page an operator opens when a pod is misbehaving. What is asserted
// here is that the things explaining *why* survive the trip to the
// screen — the previous container state, the restart count, and the
// separation of init containers from app containers.

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    Channel: class {
      onmessage?: (event: unknown) => void;
    },
    api: {
      ...actual.api,
      getPod: vi.fn(),
      listEvents: vi.fn(),
      startPodLogs: vi.fn(),
      stopPodLogs: vi.fn(),
    },
  };
});

const getPod = vi.mocked(api.getPod);
const listEvents = vi.mocked(api.listEvents);
const startPodLogs = vi.mocked(api.startPodLogs);

function container(overrides: Partial<ContainerView> = {}): ContainerView {
  return {
    name: "app",
    image: "app:1.0",
    ready: true,
    restarts: 0,
    state: "Running",
    lastState: null,
    ...overrides,
  };
}

function pod(overrides: Partial<PodDetailData> = {}): PodDetailData {
  return {
    apiVersion: "v1",
    kind: "Pod",
    name: "web-abc",
    namespace: "prod",
    phase: "Running",
    node: "worker-1",
    podIp: "10.1.2.3",
    serviceAccount: "default",
    qosClass: "Burstable",
    age: "3d",
    labels: [["app", "web"]],
    annotations: [],
    containers: [container()],
    initContainers: [],
    conditions: [],
    yaml: "apiVersion: v1\nkind: Pod\n",
    ...overrides,
  };
}

function renderDetail() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PodDetail namespace="prod" name="web-abc" onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  getPod.mockReset();
  listEvents.mockReset();
  startPodLogs.mockReset();

  getPod.mockResolvedValue(pod());
  listEvents.mockResolvedValue([]);
  startPodLogs.mockResolvedValue(1);
});

describe("PodDetail overview", () => {
  it("shows where the pod is running", async () => {
    renderDetail();
    expect(await screen.findByText("worker-1")).toBeInTheDocument();
    expect(screen.getByText("10.1.2.3")).toBeInTheDocument();
    expect(screen.getByText("Burstable")).toBeInTheDocument();
  });

  it("explains a crash loop with the previous container state", async () => {
    // CrashLoopBackOff says the container keeps dying. The previous
    // state says why, and without it the next step is guesswork.
    getPod.mockResolvedValue(
      pod({
        phase: "Running",
        containers: [
          container({
            ready: false,
            restarts: 7,
            state: "Waiting: CrashLoopBackOff",
            lastState: "Terminated: OOMKilled (exit 137)",
          }),
        ],
      }),
    );

    renderDetail();
    expect(
      await screen.findByText("Waiting: CrashLoopBackOff"),
    ).toBeInTheDocument();
    expect(screen.getByText(/previously.*OOMKilled/)).toBeInTheDocument();
    expect(screen.getByText("7 restarts")).toBeInTheDocument();
  });

  it("says restart rather than restarts for a single one", async () => {
    getPod.mockResolvedValue(
      pod({ containers: [container({ restarts: 1 })] }),
    );
    renderDetail();
    expect(await screen.findByText("1 restart")).toBeInTheDocument();
  });

  it("does not show a restart count for a pod that has not restarted", async () => {
    // A "0 restarts" chip on every healthy pod is noise.
    renderDetail();
    await screen.findByText("worker-1");
    expect(screen.queryByText(/restart/)).not.toBeInTheDocument();
  });

  it("keeps init containers separate from app containers", async () => {
    // An init container stuck pulling its image is a common reason a pod
    // never starts, and merging the lists hides which phase it is in.
    getPod.mockResolvedValue(
      pod({
        phase: "Pending",
        initContainers: [
          container({ name: "migrate", state: "Waiting: ImagePullBackOff", ready: false }),
        ],
      }),
    );

    renderDetail();
    expect(await screen.findByText("Init containers")).toBeInTheDocument();
    expect(screen.getByText("Containers")).toBeInTheDocument();
    expect(screen.getByText("migrate")).toBeInTheDocument();
  });

  it("omits the init containers section when there are none", async () => {
    renderDetail();
    await screen.findByText("worker-1");
    expect(screen.queryByText("Init containers")).not.toBeInTheDocument();
  });

  it("shows the pod's phase beside its name", async () => {
    getPod.mockResolvedValue(pod({ phase: "Pending" }));
    renderDetail();
    expect(await screen.findByText("Pending")).toBeInTheDocument();
  });

  it("shows a condition's message when it has one", async () => {
    getPod.mockResolvedValue(
      pod({
        conditions: [
          {
            type: "PodScheduled",
            status: "False",
            reason: "Unschedulable",
            message: "0/3 nodes are available: 3 Insufficient cpu.",
          },
        ],
      }),
    );

    renderDetail();
    expect(await screen.findByText(/Insufficient cpu/)).toBeInTheDocument();
    expect(screen.getByText("PodScheduled: False")).toBeInTheDocument();
  });

  it("surfaces a failure to read the pod", async () => {
    // A pod deleted while its page was open is the common case, and the
    // page has to say so rather than sit on a skeleton forever.
    getPod.mockRejectedValue({
      kind: "kubernetes",
      message: 'pods "web-abc" not found',
    });
    renderDetail();
    expect(await screen.findByText(/not found/)).toBeInTheDocument();
  });
});

describe("PodDetail tabs", () => {
  it("streams logs from every container in the pod", async () => {
    // Including init containers: their output is where an init failure
    // explains itself, and it is unreachable from anywhere else.
    getPod.mockResolvedValue(
      pod({
        initContainers: [container({ name: "migrate" })],
        containers: [container({ name: "app" })],
      }),
    );

    const user = renderDetail();
    await screen.findByText("worker-1");
    await user.click(screen.getByRole("button", { name: "Logs" }));

    const picker = await screen.findByRole("combobox");
    expect(picker).toHaveTextContent("migrate");
    expect(picker).toHaveTextContent("app");
  });

  it("opens the events tab against this pod alone", async () => {
    const user = renderDetail();
    await screen.findByText("worker-1");
    await user.click(screen.getByRole("button", { name: "Events" }));

    expect(listEvents).toHaveBeenCalledWith("prod", "web-abc");
  });

  it("renders the YAML the server sent", async () => {
    const user = renderDetail();
    await screen.findByText("worker-1");
    await user.click(screen.getByRole("button", { name: "YAML" }));

    expect(await screen.findByText(/kind/)).toBeInTheDocument();
  });
});
