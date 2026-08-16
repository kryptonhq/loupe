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
    api: {
      ...actual.api,
      listContexts: vi.fn(),
      connect: vi.fn(),
      getSettings: vi.fn(),
      setContextPinned: vi.fn(),
      connectedClusters: vi.fn(),
    },
  };
});

vi.mock("../lib/window", () => ({
  dragRegionProps: {},
}));

const listContexts = vi.mocked(api.listContexts);
const connect = vi.mocked(api.connect);
const getSettings = vi.mocked(api.getSettings);
const setContextPinned = vi.mocked(api.setContextPinned);
const connectedClusters = vi.mocked(api.connectedClusters);

function settings(over: Partial<import("../lib/api").Settings> = {}) {
  return { theme: "system" as const, recentContexts: [], pinnedContexts: [], ...over };
}

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
  getSettings.mockReset();
  setContextPinned.mockReset();
  getSettings.mockResolvedValue(settings());
  connectedClusters.mockReset();
  connectedClusters.mockResolvedValue([]);
  setContextPinned.mockImplementation(async (context, pinned) =>
    settings({ pinnedContexts: pinned ? [context] : [] }),
  );

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

  // Scale. A kubeconfig with thousands of contexts is ordinary in a
  // large org, and the picker is the first screen — if it stutters
  // there, nothing after it gets evaluated.

  it("renders only the rows on screen for a huge kubeconfig", async () => {
    // 6,000 contexts as 6,000 buttons is the thing being prevented: the
    // browser lays out every one of them before first paint.
    listContexts.mockResolvedValue(
      Array.from({ length: 6000 }, (_, i) => context(`cluster-${i}`)),
    );

    renderPicker();
    await screen.findByText("cluster-0");

    const rendered = screen.getAllByRole("button", { name: /^Pin cluster-/ });
    expect(rendered.length).toBeLessThan(100);
  });

  it("stays interactive while typing against thousands of contexts", async () => {
    listContexts.mockResolvedValue(
      Array.from({ length: 6000 }, (_, i) => context(`cluster-${i}`)),
    );

    const { user } = renderPicker();
    await screen.findByText("cluster-0");

    await user.type(screen.getByLabelText("Filter contexts"), "cluster-4242");
    expect(await screen.findByText("cluster-4242")).toBeInTheDocument();
  });

  it("ranks an exact match first rather than burying it", async () => {
    // The specific failure that makes a long list feel broken: typing a
    // cluster's full name and finding it thirtieth.
    listContexts.mockResolvedValue([
      context("prod-eu"),
      context("prod-us"),
      context("prod"),
      // Padding, so the list is long enough to be given a filter box.
      ...Array.from({ length: 6 }, (_, i) => context(`other-${i}`)),
    ]);

    const { user } = renderPicker();
    await screen.findByText("prod-eu");
    await user.type(screen.getByLabelText("Filter contexts"), "prod");

    const names = screen
      .getAllByRole("button", { name: /^Pin / })
      .map((b) => b.getAttribute("aria-label")?.replace("Pin ", ""));
    expect(names[0]).toBe("prod");
  });

  it("puts recently used contexts above the rest", async () => {
    // On six thousand contexts, four names are the ones anyone opens.
    listContexts.mockResolvedValue([
      context("a"),
      context("b"),
      context("zeta"),
    ]);
    getSettings.mockResolvedValue(settings({ recentContexts: ["zeta"] }));

    renderPicker();
    expect(await screen.findByText("Recent")).toBeInTheDocument();

    const names = screen
      .getAllByRole("button", { name: /^Pin / })
      .map((b) => b.getAttribute("aria-label")?.replace("Pin ", ""));
    expect(names[0]).toBe("zeta");
  });

  it("puts pinned contexts above recents", async () => {
    listContexts.mockResolvedValue([context("a"), context("b"), context("c")]);
    getSettings.mockResolvedValue(
      settings({ recentContexts: ["b"], pinnedContexts: ["c"] }),
    );

    renderPicker();
    await screen.findByText("Pinned");

    const names = screen
      .getAllByRole("button", { name: /^(Pin|Unpin) / })
      .map((b) => b.getAttribute("aria-label")?.replace(/^(Pin|Unpin) /, ""));
    expect(names.slice(0, 2)).toEqual(["c", "b"]);
  });

  it("pins a context and remembers it", async () => {
    listContexts.mockResolvedValue([context("prod"), context("dev")]);

    const { user } = renderPicker();
    await screen.findByText("prod");

    await user.click(screen.getByRole("button", { name: "Pin prod" }));

    await waitFor(() => expect(setContextPinned).toHaveBeenCalledWith("prod", true));
    expect(await screen.findByText("Pinned")).toBeInTheDocument();
  });

  it("unpins a context that was pinned", async () => {
    listContexts.mockResolvedValue([context("prod")]);
    getSettings.mockResolvedValue(settings({ pinnedContexts: ["prod"] }));
    setContextPinned.mockResolvedValue(settings());

    const { user } = renderPicker();
    await screen.findByRole("button", { name: "Unpin prod" });

    await user.click(screen.getByRole("button", { name: "Unpin prod" }));
    await waitFor(() => expect(setContextPinned).toHaveBeenCalledWith("prod", false));
  });

  it("puts a pin back when it could not be saved", async () => {
    // A pin that silently does not survive the next launch is worse than
    // one that visibly failed.
    listContexts.mockResolvedValue([context("prod")]);
    setContextPinned.mockRejectedValue({ kind: "settings", message: "read-only" });

    const { user } = renderPicker();
    await screen.findByText("prod");

    await user.click(screen.getByRole("button", { name: "Pin prod" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pin prod" })).toBeInTheDocument(),
    );
  });

  it("does not list a pinned context twice", async () => {
    // Pinned and recent are the same context here; showing it in both
    // groups makes clicking one of them look broken.
    listContexts.mockResolvedValue([context("prod"), context("dev")]);
    getSettings.mockResolvedValue(
      settings({ recentContexts: ["prod"], pinnedContexts: ["prod"] }),
    );

    renderPicker();
    await screen.findByText("Pinned");

    expect(screen.getAllByRole("button", { name: /^Unpin prod$/ })).toHaveLength(1);
    expect(screen.queryByText("Recent")).not.toBeInTheDocument();
  });

  it("ignores a remembered context that is no longer in the kubeconfig", async () => {
    // Contexts get removed. A stale recent must not produce a row that
    // cannot be connected to.
    listContexts.mockResolvedValue([context("prod")]);
    getSettings.mockResolvedValue(
      settings({ recentContexts: ["deleted"], pinnedContexts: ["also-deleted"] }),
    );

    renderPicker();
    await screen.findByText("prod");

    expect(screen.queryByText("deleted")).not.toBeInTheDocument();
    expect(screen.queryByText("also-deleted")).not.toBeInTheDocument();
  });

  it("still lists contexts when preferences cannot be read", async () => {
    // Recents are a convenience; losing them must not lose the picker.
    getSettings.mockRejectedValue({ kind: "settings", message: "no config dir" });

    renderPicker();
    expect(await screen.findByText("prod")).toBeInTheDocument();
  });
});

// Several clusters connected at once. The point is that coming back to
// one costs nothing: its client and its API discovery are still held, so
// the switch re-authenticates nothing and re-walks nothing.
describe("ContextPicker with several clusters connected", () => {
  it("marks a context that is already connected", async () => {
    listContexts.mockResolvedValue([context("prod"), context("staging")]);
    connectedClusters.mockResolvedValue([
      {
        context: "staging",
        server: "https://staging:6443",
        version: "v1.33.1",
        platform: "linux/arm64",
      },
    ]);

    renderPicker();
    expect(await screen.findByText("connected")).toBeInTheDocument();
  });

  it("does not mark the one already on screen twice", async () => {
    // The live cluster already carries its own badge; a second one
    // saying the same thing is noise.
    listContexts.mockResolvedValue([context("prod")]);
    connectedClusters.mockResolvedValue([
      {
        context: "prod",
        server: "https://prod:6443",
        version: "v1.33.1",
        platform: "linux/arm64",
      },
    ]);

    renderPicker({
      current: {
        context: "prod",
        server: "https://prod:6443",
        version: "v1.33.1",
        platform: "linux/arm64",
      },
    });

    await screen.findByText("prod");
    expect(screen.getAllByText("connected")).toHaveLength(1);
  });

  it("still lists contexts when the connected set cannot be read", async () => {
    // A convenience badge losing its data must not lose the picker.
    connectedClusters.mockRejectedValue({
      kind: "not_connected",
      message: "not connected",
    });

    renderPicker();
    expect(await screen.findByText("prod")).toBeInTheDocument();
  });
});
