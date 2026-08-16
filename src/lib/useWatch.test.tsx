import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useWatch } from "./useWatch";
import { api, type GvkRef, type WatchEvent } from "./api";

// The replacement for polling every ten seconds. What matters is that
// nothing is fetched until something changes, that a burst of changes is
// one refetch rather than dozens, that the connection is closed when the
// view goes away, and that a watch which has died says so — a listing
// that has quietly stopped updating is worse than one that admits it.

vi.mock("./api", async (original) => {
  const actual = await original<typeof import("./api")>();
  return {
    ...actual,
    Channel: class {
      onmessage?: (event: WatchEvent) => void;
    },
    api: { ...actual.api, startWatch: vi.fn(), stopWatch: vi.fn() },
  };
});

const startWatch = vi.mocked(api.startWatch);
const stopWatch = vi.mocked(api.stopWatch);

const POD: GvkRef = { group: "", version: "v1", kind: "Pod" };

let channels: { onmessage?: (e: WatchEvent) => void }[] = [];
let client: QueryClient;
let invalidated: number;

function Probe({ enabled = true }: { enabled?: boolean }) {
  const { live, error } = useWatch(POD, "payments", ["table", "pods"], enabled);
  return (
    <div>
      <span data-testid="live">{String(live)}</span>
      <span data-testid="error">{error ?? ""}</span>
    </div>
  );
}

function setup(enabled = true) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidated = 0;
  const original = client.invalidateQueries.bind(client);
  client.invalidateQueries = ((...args: Parameters<typeof original>) => {
    invalidated += 1;
    return original(...args);
  }) as typeof client.invalidateQueries;

  return render(
    <QueryClientProvider client={client}>
      <Probe enabled={enabled} />
    </QueryClientProvider>,
  );
}

function emit(event: WatchEvent) {
  act(() => {
    channels[channels.length - 1]?.onmessage?.(event);
  });
}

function change(name = "api-7d9"): WatchEvent {
  return { kind: "changed", change: "applied", name, namespace: "payments" };
}

beforeEach(() => {
  vi.useRealTimers();
  channels = [];
  startWatch.mockReset();
  stopWatch.mockReset();

  let nextId = 1;
  startWatch.mockImplementation(async (_resource, _namespace, channel) => {
    channels.push(channel as unknown as { onmessage?: (e: WatchEvent) => void });
    return nextId++;
  });
  stopWatch.mockResolvedValue(true);
});

describe("useWatch", () => {
  it("watches the kind and namespace it was given", async () => {
    setup();
    await waitFor(() => expect(startWatch).toHaveBeenCalled());

    const [resource, namespace] = startWatch.mock.calls[0];
    expect(resource).toEqual(POD);
    expect(namespace).toBe("payments");
  });

  it("reports itself live once the watch is open", async () => {
    setup();
    await waitFor(() => expect(screen.getByTestId("live")).toHaveTextContent("true"));
  });

  it("fetches nothing until something changes", async () => {
    // The whole point. A ten-second timer fired whether or not anything
    // had happened; this does not.
    setup();
    await waitFor(() => expect(startWatch).toHaveBeenCalled());

    await new Promise((r) => setTimeout(r, 600));
    expect(invalidated).toBe(0);
  });

  it("refetches when an object changes", async () => {
    setup();
    await waitFor(() => expect(startWatch).toHaveBeenCalled());

    emit(change());
    await waitFor(() => expect(invalidated).toBe(1));
  });

  it("coalesces a burst into one refetch", async () => {
    // A rollout produces dozens of events in a second. Refetching per
    // event would be worse than the polling this replaces.
    setup();
    await waitFor(() => expect(startWatch).toHaveBeenCalled());

    for (let i = 0; i < 20; i += 1) emit(change(`api-${i}`));

    await waitFor(() => expect(invalidated).toBe(1));
    await new Promise((r) => setTimeout(r, 600));
    expect(invalidated).toBe(1);
  });

  it("refetches after a relist rather than trusting the cache", async () => {
    setup();
    await waitFor(() => expect(startWatch).toHaveBeenCalled());

    emit({ kind: "reset" });
    await waitFor(() => expect(invalidated).toBe(1));
  });

  it("says so when the watch dies", async () => {
    // A listing that has quietly stopped updating is worse than one
    // that admits it.
    setup();
    await waitFor(() => expect(startWatch).toHaveBeenCalled());

    emit({ kind: "failed", message: "watch closed unexpectedly" });

    await waitFor(() =>
      expect(screen.getByTestId("error")).toHaveTextContent("watch closed"),
    );
    expect(screen.getByTestId("live")).toHaveTextContent("false");
  });

  it("reports a watch that could not be opened at all", async () => {
    startWatch.mockRejectedValue({
      kind: "kubernetes",
      message: 'pods is forbidden: User "dev" cannot watch',
    });

    setup();
    await waitFor(() =>
      expect(screen.getByTestId("error")).toHaveTextContent("forbidden"),
    );
  });

  it("closes the watch when the view goes away", async () => {
    // An open watch against a cluster nobody is looking at is a
    // connection the user does not know about.
    const view = setup();
    await waitFor(() => expect(startWatch).toHaveBeenCalled());

    view.unmount();
    await waitFor(() => expect(stopWatch).toHaveBeenCalledWith(1));
  });

  it("does not refetch after the view has gone", async () => {
    const view = setup();
    await waitFor(() => expect(startWatch).toHaveBeenCalled());

    emit(change());
    view.unmount();

    await new Promise((r) => setTimeout(r, 600));
    expect(invalidated).toBe(0);
  });

  it("opens nothing when disabled", async () => {
    setup(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(startWatch).not.toHaveBeenCalled();
  });
});
