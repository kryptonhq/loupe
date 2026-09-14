import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useProblems } from "./useProblems";
import { api, type ProblemsSnapshot } from "./api";

// One subscription for the window. What matters: it follows the cluster
// (a snapshot of one must never show under another's name), it stops the
// monitor when it goes away, and a failure to start is said.

vi.mock("./api", async (original) => {
  const actual = await original<typeof import("./api")>();
  return {
    ...actual,
    Channel: class {
      onmessage?: (s: ProblemsSnapshot) => void;
    },
    api: { ...actual.api, startProblems: vi.fn(), stopProblems: vi.fn() },
  };
});

const startProblems = vi.mocked(api.startProblems);
const stopProblems = vi.mocked(api.stopProblems);
let channels: { onmessage?: (s: ProblemsSnapshot) => void }[] = [];

function Probe({ context }: { context: string | null }) {
  const { snapshot, error } = useProblems(context);
  return (
    <div>
      <span data-testid="count">{snapshot ? snapshot.problems.length : "none"}</span>
      <span data-testid="error">{error ?? ""}</span>
    </div>
  );
}

const snap = (n: number) =>
  ({ problems: Array(n).fill({}), sources: [], generatedAt: 0, graceSeconds: 120, restartThreshold: 5 }) as unknown as ProblemsSnapshot;

beforeEach(() => {
  channels = [];
  let next = 1;
  startProblems.mockReset().mockImplementation(async (channel) => {
    channels.push(channel as never);
    return next++;
  });
  stopProblems.mockReset().mockResolvedValue(true);
});

describe("useProblems", () => {
  it("does nothing without a cluster", () => {
    render(<Probe context={null} />);
    expect(startProblems).not.toHaveBeenCalled();
  });

  it("shows snapshots as they arrive", async () => {
    render(<Probe context="prod" />);
    await waitFor(() => expect(startProblems).toHaveBeenCalledTimes(1));
    act(() => channels[0].onmessage?.(snap(3)));
    expect(screen.getByTestId("count")).toHaveTextContent("3");
  });

  it("restarts for a new cluster and drops the old cluster's answer", async () => {
    const { rerender } = render(<Probe context="prod" />);
    await waitFor(() => expect(startProblems).toHaveBeenCalledTimes(1));
    act(() => channels[0].onmessage?.(snap(3)));

    rerender(<Probe context="staging" />);
    expect(screen.getByTestId("count")).toHaveTextContent("none");
    await waitFor(() => expect(startProblems).toHaveBeenCalledTimes(2));
    expect(stopProblems).toHaveBeenCalledWith(1);

    // A late message from the old monitor must not land.
    act(() => channels[0].onmessage?.(snap(9)));
    expect(screen.getByTestId("count")).toHaveTextContent("none");
  });

  it("stops the monitor when unmounted", async () => {
    const { unmount } = render(<Probe context="prod" />);
    await waitFor(() => expect(startProblems).toHaveBeenCalled());
    await act(async () => {});
    unmount();
    expect(stopProblems).toHaveBeenCalledWith(1);
  });

  it("stops a monitor that finished starting after the view had gone", async () => {
    let resolve: (id: number) => void = () => {};
    startProblems.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const { unmount } = render(<Probe context="prod" />);
    await waitFor(() => expect(startProblems).toHaveBeenCalled());
    unmount();
    await act(async () => resolve(42));
    expect(stopProblems).toHaveBeenCalledWith(42);
  });

  it("says when the monitor could not start", async () => {
    startProblems.mockRejectedValueOnce({ kind: "not_connected", message: "not connected to a cluster" });
    render(<Probe context="prod" />);
    await waitFor(() =>
      expect(screen.getByTestId("error")).toHaveTextContent("not connected to a cluster"),
    );
  });
});
