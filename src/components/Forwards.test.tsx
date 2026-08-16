import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ForwardsPanel,
  StartForward,
  describeTarget,
  formatBytes,
} from "./Forwards";
import { api, type ForwardView } from "../lib/api";

// The panel is the feature: a terminal gives you one forward per window
// and no memory of what you had open. What is asserted here is that
// several are visible at once, that their state is legible, and that a
// port collision is reported rather than swallowed.

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      startForward: vi.fn(),
      listForwards: vi.fn(),
      stopForward: vi.fn(),
    },
  };
});

const startForward = vi.mocked(api.startForward);
const listForwards = vi.mocked(api.listForwards);
const stopForward = vi.mocked(api.stopForward);

function forward(over: Partial<ForwardView> = {}): ForwardView {
  return {
    id: 1,
    target: { kind: "pod", namespace: "payments", name: "api-7d9" },
    localPort: 8080,
    remotePort: 8080,
    bytes: 0,
    connections: 0,
    lastError: null,
    ...over,
  };
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderPanel() {
  render(
    <QueryClientProvider client={client()}>
      <ForwardsPanel />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

function renderStart(ports = [8080]) {
  render(
    <QueryClientProvider client={client()}>
      <StartForward
        target={{ kind: "pod", namespace: "payments", name: "api-7d9" }}
        ports={ports}
      />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  startForward.mockReset();
  listForwards.mockReset();
  stopForward.mockReset();
  listForwards.mockResolvedValue([]);
  stopForward.mockResolvedValue(true);
  startForward.mockResolvedValue(forward());
});

describe("ForwardsPanel", () => {
  it("shows nothing at all when nothing is forwarding", async () => {
    renderPanel();
    await waitFor(() => expect(listForwards).toHaveBeenCalled());
    expect(screen.queryByText("Port forwards")).not.toBeInTheDocument();
  });

  it("lists several forwards at once", async () => {
    // The thing a terminal cannot do.
    listForwards.mockResolvedValue([
      forward({ id: 1, localPort: 8080 }),
      forward({
        id: 2,
        localPort: 5432,
        remotePort: 5432,
        target: { kind: "service", namespace: "payments", name: "postgres" },
      }),
    ]);

    renderPanel();
    expect(await screen.findByText(/8080 → pod\/api-7d9:8080/)).toBeInTheDocument();
    expect(screen.getByText(/5432 → svc\/postgres:5432/)).toBeInTheDocument();
  });

  it("shows traffic, so an idle forward is not mistaken for a broken one", async () => {
    listForwards.mockResolvedValue([
      forward({ bytes: 2048, connections: 3 }),
    ]);

    renderPanel();
    expect(await screen.findByText(/3 connections/)).toBeInTheDocument();
    expect(screen.getByText(/2\.0 kB/)).toBeInTheDocument();
  });

  it("keeps showing the last error rather than clearing it", async () => {
    // A forward that failed an hour ago still needs to say why, or it
    // just looks idle.
    listForwards.mockResolvedValue([
      forward({ lastError: "api-7d9 has no running pods to forward to" }),
    ]);

    renderPanel();
    expect(await screen.findByText(/no running pods/)).toBeInTheDocument();
  });

  it("stops a forward and releases its port", async () => {
    listForwards.mockResolvedValue([forward({ id: 7 })]);

    const user = renderPanel();
    await user.click(await screen.findByRole("button", { name: "Stop" }));

    await waitFor(() => expect(stopForward).toHaveBeenCalledWith(7));
  });
});

describe("StartForward", () => {
  it("offers the port the object declares", async () => {
    renderStart([9090]);
    expect(screen.getByLabelText("Remote port")).toHaveValue("9090");
    // Local defaults to the same, which is what anyone expects.
    expect(screen.getByLabelText("Local port")).toHaveValue("9090");
  });

  it("starts a forward on the ports given", async () => {
    const user = renderStart([8080]);

    const local = screen.getByLabelText("Local port");
    await user.clear(local);
    await user.type(local, "18080");
    await user.click(screen.getByRole("button", { name: "Forward" }));

    await waitFor(() =>
      expect(startForward).toHaveBeenCalledWith(
        { kind: "pod", namespace: "payments", name: "api-7d9" },
        18080,
        8080,
      ),
    );
  });

  it("reports a port collision rather than swallowing it", async () => {
    // The most common outcome, and the one the user can act on.
    startForward.mockRejectedValue({
      kind: "kubernetes",
      message: "port 8080 is already in use on this machine",
    });

    const user = renderStart();
    await user.click(screen.getByRole("button", { name: "Forward" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("already in use");
  });
});

describe("formatBytes", () => {
  it("reads as bytes, kilobytes and megabytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 kB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("describeTarget", () => {
  it("distinguishes a pod from a service", () => {
    // Which one matters: a service target survives a rollout and a pod
    // target does not.
    expect(
      describeTarget({ kind: "pod", namespace: "n", name: "api-7d9" }),
    ).toBe("pod/api-7d9");
    expect(
      describeTarget({ kind: "service", namespace: "n", name: "api" }),
    ).toBe("svc/api");
  });
});
