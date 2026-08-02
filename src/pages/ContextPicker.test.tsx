import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextPicker } from "./ContextPicker";
import { api, type ContextInfo } from "../lib/api";

// The launch screen. Listing contexts is offline by design, so this
// renders even when every cluster in the file is unreachable — which
// means connecting is where failure becomes visible, and it has to
// report per attempt rather than blanking the list.

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, listContexts: vi.fn(), connect: vi.fn() },
  };
});

vi.mock("../lib/window", () => ({
  dragRegionProps: {},
}));

const listContexts = vi.mocked(api.listContexts);
const connect = vi.mocked(api.connect);

function context(name: string, overrides: Partial<ContextInfo> = {}): ContextInfo {
  return {
    name,
    cluster: `${name}-cluster`,
    user: `${name}-user`,
    namespace: null,
    isCurrent: false,
    ...overrides,
  };
}

function renderPicker(props: Partial<Parameters<typeof ContextPicker>[0]> = {}) {
  const onConnected = vi.fn();
  render(<ContextPicker onConnected={onConnected} {...props} />);
  return { user: userEvent.setup(), onConnected };
}

beforeEach(() => {
  listContexts.mockReset();
  connect.mockReset();

  listContexts.mockResolvedValue([
    context("prod", { namespace: "payments" }),
    context("staging", { isCurrent: true }),
  ]);
  connect.mockResolvedValue({
    context: "prod",
    server: "https://prod:6443",
    version: "v1.33.1",
    platform: "linux/arm64",
  });
});

describe("ContextPicker", () => {
  it("lists every context in the kubeconfig", async () => {
    renderPicker();
    expect(await screen.findByText("prod")).toBeInTheDocument();
    expect(screen.getByText("staging")).toBeInTheDocument();
    // The cluster and default namespace disambiguate contexts that are
    // named alike across files.
    expect(screen.getByText(/prod-cluster · payments/)).toBeInTheDocument();
  });

  it("marks what kubectl would have used", async () => {
    // So the obvious choice is the same one the terminal in the next
    // window is pointed at.
    renderPicker();
    expect(await screen.findByText("kubeconfig default")).toBeInTheDocument();
  });

  it("marks the live connection rather than the kubeconfig default", async () => {
    // When switching clusters, "connected" is the more useful label, and
    // showing both on different rows would be ambiguous.
    renderPicker({
      current: {
        context: "prod",
        server: "https://prod:6443",
        version: "v1.33.1",
        platform: "linux/arm64",
      },
    });
    expect(await screen.findByText("connected")).toBeInTheDocument();
  });

  it("connects to the context that was clicked", async () => {
    const { user, onConnected } = renderPicker();
    await user.click(await screen.findByText("prod"));

    await waitFor(() => expect(connect).toHaveBeenCalledWith("prod"));
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
  });

  it("reports a failed connection without losing the list", async () => {
    // A cluster being unreachable is the normal case on a laptop. The
    // other contexts must stay clickable.
    connect.mockRejectedValue({
      kind: "kubernetes",
      message: "error trying to connect: tcp connect error",
    });

    const { user, onConnected } = renderPicker();
    await user.click(await screen.findByText("prod"));

    expect(await screen.findByText(/tcp connect error/)).toBeInTheDocument();
    expect(onConnected).not.toHaveBeenCalled();
    expect(screen.getByText("staging")).toBeInTheDocument();
  });

  it("explains an empty kubeconfig rather than showing nothing", async () => {
    // A blank screen here reads as a broken app; naming KUBECONFIG is
    // the actual next step.
    listContexts.mockResolvedValue([]);
    renderPicker();
    expect(await screen.findByText(/No contexts found/)).toBeInTheDocument();
    expect(screen.getByText("KUBECONFIG")).toBeInTheDocument();
  });

  it("reports a kubeconfig that could not be read", async () => {
    listContexts.mockRejectedValue({
      kind: "kubeconfig",
      message: "kubeconfig: invalid YAML at line 4",
    });
    renderPicker();
    expect(await screen.findByText(/invalid YAML/)).toBeInTheDocument();
  });

  it("offers a filter only once the list is long enough to need one", async () => {
    renderPicker();
    await screen.findByText("prod");
    expect(
      screen.queryByPlaceholderText("Filter contexts…"),
    ).not.toBeInTheDocument();

    listContexts.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => context(`cluster-${i}`)),
    );
    renderPicker();
    expect(
      await screen.findByPlaceholderText("Filter contexts…"),
    ).toBeInTheDocument();
  });

  it("filters on the cluster as well as the context name", async () => {
    listContexts.mockResolvedValue([
      ...Array.from({ length: 6 }, (_, i) => context(`ctx-${i}`)),
      context("odd-name", { cluster: "eu-west-1-prod" }),
    ]);

    const { user } = renderPicker();
    await user.type(
      await screen.findByPlaceholderText("Filter contexts…"),
      "eu-west",
    );

    expect(screen.getByText("odd-name")).toBeInTheDocument();
    expect(screen.queryByText("ctx-0")).not.toBeInTheDocument();
  });

  it("says so when the filter matches nothing", async () => {
    listContexts.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => context(`ctx-${i}`)),
    );
    const { user } = renderPicker();
    await user.type(
      await screen.findByPlaceholderText("Filter contexts…"),
      "zzz",
    );
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
  });

  it("can be dismissed with Escape when it is a switcher", async () => {
    // As a launch screen there is nothing behind it to go back to, so
    // Escape only means something when onCancel is given.
    const onCancel = vi.fn();
    const { user } = renderPicker({ onCancel });
    await screen.findByText("prod");

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("offers no cancel on the launch screen", async () => {
    renderPicker();
    await screen.findByText("prod");
    expect(
      screen.queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();
  });

  it("blocks a second attempt while one is in flight", async () => {
    // Two connects racing would leave the session pointing at whichever
    // finished last, which is not necessarily the one that was clicked.
    connect.mockImplementation(() => new Promise(() => {}));
    const { user } = renderPicker();
    await user.click(await screen.findByText("prod"));

    await waitFor(() =>
      expect(screen.getByText("Connecting…")).toBeInTheDocument(),
    );
    expect(screen.getByText("staging").closest("button")).toBeDisabled();
  });
});
