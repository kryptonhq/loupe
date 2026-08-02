import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Crds, kindKey } from "./Crds";
import { api, type ApiResourceInfo } from "../lib/api";

// The index of every kind the cluster serves. It leads with custom
// resources because the built-ins already have dedicated views, and an
// unfiltered list of ~70 kinds buries the handful anyone came for.

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listApiResources: vi.fn(),
      refreshApiResources: vi.fn(),
    },
  };
});

const listApiResources = vi.mocked(api.listApiResources);
const refreshApiResources = vi.mocked(api.refreshApiResources);

function resource(overrides: Partial<ApiResourceInfo> = {}): ApiResourceInfo {
  return {
    group: "krypton.ai",
    version: "v1alpha1",
    kind: "Agent",
    plural: "agents",
    apiVersion: "krypton.ai/v1alpha1",
    namespaced: true,
    verbs: ["get", "list", "watch", "update"],
    custom: true,
    ...overrides,
  };
}

const POD = resource({
  group: "",
  version: "v1",
  kind: "Pod",
  plural: "pods",
  apiVersion: "v1",
  custom: false,
});

function renderCrds() {
  const onSelectKind = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Crds onSelectKind={onSelectKind} />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), onSelectKind };
}

beforeEach(() => {
  listApiResources.mockReset();
  refreshApiResources.mockReset();
  listApiResources.mockResolvedValue([resource(), POD]);
});

describe("kindKey", () => {
  it("keeps two versions of one kind distinct", () => {
    // A CRD served at both v1alpha1 and v1 is two rows, and one key for
    // both would collapse them or cross-wire the query cache.
    expect(kindKey(resource({ version: "v1alpha1" }))).not.toBe(
      kindKey(resource({ version: "v1" })),
    );
  });

  it("keeps the same kind in two groups distinct", () => {
    expect(kindKey(resource({ group: "a.io" }))).not.toBe(
      kindKey(resource({ group: "b.io" })),
    );
  });
});

describe("Crds", () => {
  it("leads with custom resources and holds the built-ins back", async () => {
    renderCrds();
    expect(await screen.findByText("Agent")).toBeInTheDocument();
    expect(screen.queryByText("Pod")).not.toBeInTheDocument();
  });

  it("shows the built-ins when asked", async () => {
    const { user } = renderCrds();
    await screen.findByText("Agent");

    await user.selectOptions(screen.getByRole("combobox"), "all");
    expect(screen.getByText("Pod")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
  });

  it("names the core group rather than showing a blank cell", async () => {
    const { user } = renderCrds();
    await screen.findByText("Agent");
    await user.selectOptions(screen.getByRole("combobox"), "all");

    expect(screen.getByText("core")).toBeInTheDocument();
  });

  it("says whether a kind can be edited before it is opened", async () => {
    // Better than finding no Edit button after opening one.
    listApiResources.mockResolvedValue([
      resource({ kind: "Agent", verbs: ["get", "list", "update"] }),
      resource({ kind: "AgentRun", verbs: ["get", "list"] }),
    ]);

    renderCrds();
    expect(await screen.findByText("read/write")).toBeInTheDocument();
    expect(screen.getByText("read-only")).toBeInTheDocument();
  });

  it("says whether a kind is namespaced", async () => {
    listApiResources.mockResolvedValue([
      resource({ kind: "Agent", namespaced: true }),
      resource({ kind: "ClusterAgent", namespaced: false }),
    ]);

    renderCrds();
    expect(await screen.findByText("Namespaced")).toBeInTheDocument();
    expect(screen.getByText("Cluster")).toBeInTheDocument();
  });

  it("reports a chosen kind upward rather than opening it here", async () => {
    // The sidebar picks kinds too, and two owners of one selection drift
    // apart the moment either changes it.
    const { user, onSelectKind } = renderCrds();
    await user.click(await screen.findByText("Agent"));

    expect(onSelectKind).toHaveBeenCalledWith({
      id: "krypton.ai/v1alpha1/Agent",
      label: "Agent",
      gvk: { group: "krypton.ai", version: "v1alpha1", kind: "Agent" },
    });
  });

  it("rediscovers rather than refetching a cache", async () => {
    // This button exists for the CRD installed a minute ago, which a
    // cached discovery cannot see however many times it is re-read.
    refreshApiResources.mockResolvedValue([resource({ kind: "NewCrd" })]);

    const { user } = renderCrds();
    await screen.findByText("Agent");
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(refreshApiResources).toHaveBeenCalledOnce());
    expect(await screen.findByText("NewCrd")).toBeInTheDocument();
  });

  it("points at the built-ins when no CRDs are installed", async () => {
    // A bare "nothing here" would look like discovery failed.
    listApiResources.mockResolvedValue([POD]);
    renderCrds();
    expect(
      await screen.findByText(/No custom resources are installed/),
    ).toBeInTheDocument();
  });

  it("surfaces a discovery failure", async () => {
    listApiResources.mockRejectedValue({
      kind: "not_connected",
      message: "not connected to a cluster",
    });
    renderCrds();
    expect(await screen.findByText(/not connected/)).toBeInTheDocument();
  });
});
