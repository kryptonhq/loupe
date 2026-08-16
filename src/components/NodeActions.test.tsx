import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NodeActions, describe as describeEvent } from "./NodeActions";
import { ClusterContext } from "../lib/clusterContext";
import { api, type DrainEvent, type Guard } from "../lib/api";

// Drain is the only action in the app that is not a single request: it
// is a sequence of independent evictions, several expected to be
// skipped and any of which a PodDisruptionBudget may refuse. Reporting
// it as one spinner would hide exactly what matters — which pod would
// not move, and why.

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    Channel: class {
      onmessage?: (event: DrainEvent) => void;
    },
    api: {
      ...actual.api,
      setNodeSchedulable: vi.fn(),
      drainNode: vi.fn(),
    },
  };
});

const setNodeSchedulable = vi.mocked(api.setNodeSchedulable);
const drainNode = vi.mocked(api.drainNode);

let channels: { onmessage?: (e: DrainEvent) => void }[] = [];

function setup({
  schedulable = true,
  guard = "open" as Guard,
  context = "kind-local",
} = {}) {
  const onDone = vi.fn();
  render(
    <ClusterContext.Provider value={{ context, guard }}>
      <NodeActions node="worker-1" schedulable={schedulable} onDone={onDone} />
    </ClusterContext.Provider>,
  );
  return { onDone, user: userEvent.setup() };
}

beforeEach(() => {
  channels = [];
  setNodeSchedulable.mockReset();
  drainNode.mockReset();
  setNodeSchedulable.mockResolvedValue(false);
  drainNode.mockImplementation(async (_node, channel) => {
    channels.push(channel as unknown as { onmessage?: (e: DrainEvent) => void });
  });
});

describe("NodeActions", () => {
  it("offers to cordon a schedulable node", () => {
    setup({ schedulable: true });
    expect(screen.getByRole("button", { name: "Cordon" })).toBeInTheDocument();
  });

  it("offers to uncordon one that is already cordoned", () => {
    // Showing "Cordon" on a cordoned node makes the page contradict the
    // badge next to it.
    setup({ schedulable: false });
    expect(screen.getByRole("button", { name: "Uncordon" })).toBeInTheDocument();
  });

  it("offers nothing on a read-only context", () => {
    setup({ guard: "readOnly" });
    expect(screen.queryByRole("button", { name: "Cordon" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Drain…" })).not.toBeInTheDocument();
  });

  it("cordons once confirmed", async () => {
    const { user, onDone } = setup({ schedulable: true });
    await user.click(screen.getByRole("button", { name: "Cordon" }));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cordon" }));

    await waitFor(() =>
      expect(setNodeSchedulable).toHaveBeenCalledWith("worker-1", false),
    );
    expect(onDone).toHaveBeenCalled();
  });

  it("says what cordoning does before doing it", async () => {
    // "Stops new pods" versus "evicts what is running" is the whole
    // difference between cordon and drain, and it is not obvious.
    const { user } = setup({ schedulable: true });
    await user.click(screen.getByRole("button", { name: "Cordon" }));

    expect(
      await screen.findByText(/Pods already running are left alone/),
    ).toBeInTheDocument();
  });

  it("warns that draining does not cordon", async () => {
    // Draining without cordoning first means the scheduler puts pods
    // straight back, which surprises people every time.
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Drain…" }));

    expect(await screen.findByText(/does not cordon/)).toBeInTheDocument();
  });

  it("reports each pod as the drain proceeds", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Drain…" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Drain" }));

    await waitFor(() => expect(channels).toHaveLength(1));
    const push = (event: DrainEvent) => channels[0].onmessage?.(event);

    push({ kind: "started", pods: 3 });
    push({ kind: "evicted", pod: "api-1" });
    push({ kind: "skipped", pod: "node-exporter", reason: "managed by a DaemonSet" });

    expect(await screen.findByText(/evicted api-1/)).toBeInTheDocument();
    expect(screen.getByText(/managed by a DaemonSet/)).toBeInTheDocument();
  });

  it("shows a pod that could not be evicted, and why", async () => {
    // Usually a PodDisruptionBudget refusing, which is the system
    // working. Hiding it turns a correct refusal into a mystery.
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Drain…" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Drain" }));

    await waitFor(() => expect(channels).toHaveLength(1));
    channels[0].onmessage?.({
      kind: "failed",
      pod: "api-2",
      message: "Cannot evict pod as it would violate the budget api-pdb",
    });

    expect(await screen.findByText(/api-pdb/)).toBeInTheDocument();
  });

  it("requires the context name on a protected context", async () => {
    const { user } = setup({ guard: "protected", context: "eks-prod-eu" });
    await user.click(screen.getByRole("button", { name: "Drain…" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Drain" })).toBeDisabled();
  });
});

describe("drain progress wording", () => {
  it("counts the pods it is about to attempt", () => {
    expect(describeEvent({ kind: "started", pods: 1 })).toContain("1 pod ");
    expect(describeEvent({ kind: "started", pods: 4 })).toContain("4 pods");
  });

  it("names the pod in every per-pod line", () => {
    expect(describeEvent({ kind: "evicted", pod: "api-1" })).toContain("api-1");
    expect(
      describeEvent({ kind: "skipped", pod: "ds-1", reason: "managed by a DaemonSet" }),
    ).toContain("ds-1");
    expect(
      describeEvent({ kind: "failed", pod: "api-2", message: "budget" }),
    ).toContain("api-2");
  });

  it("summarises what happened at the end", () => {
    const line = describeEvent({
      kind: "finished",
      evicted: 4,
      skipped: 2,
      failed: 1,
    });
    expect(line).toContain("4 evicted");
    expect(line).toContain("2 skipped");
    expect(line).toContain("1 failed");
  });
});
