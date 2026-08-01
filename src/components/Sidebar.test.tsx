import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Sidebar } from "./Sidebar";
import { api, type ApiResourceInfo, type ClusterInfo } from "../lib/api";

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return { ...actual, api: { ...actual.api, listApiResources: vi.fn() } };
});

const listApiResources = vi.mocked(api.listApiResources);

function resource(
  group: string,
  kind: string,
  custom = true,
): ApiResourceInfo {
  return {
    group,
    version: "v1",
    kind,
    plural: kind.toLowerCase() + "s",
    apiVersion: `${group}/v1`,
    namespaced: true,
    verbs: ["get", "list"],
    custom,
  };
}

const CRDS = [
  resource("krypton.ai", "Agent"),
  resource("krypton.ai", "Model"),
  resource("monitoring.coreos.com", "Prometheus"),
  resource("", "Pod", false),
];

const CLUSTER: ClusterInfo = {
  context: "orbstack",
  server: "https://127.0.0.1:26443",
  version: "v1.34.8",
  platform: "darwin/arm64",
};

function setup({
  cluster = CLUSTER as ClusterInfo | null,
  view = { type: "nodes" } as Parameters<typeof Sidebar>[0]["view"],
} = {}) {
  listApiResources.mockResolvedValue(CRDS);
  const onSelect = vi.fn();

  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Sidebar
        cluster={cluster}
        view={view}
        onSelect={onSelect}
        theme="system"
        onThemeChange={vi.fn()}
        onSwitchCluster={vi.fn()}
        onDisconnect={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return { onSelect, user: userEvent.setup() };
}

beforeEach(() => {
  listApiResources.mockReset();
});

describe("Sidebar CRDs section", () => {
  it("counts the custom kinds and leaves the built-ins out", async () => {
    // The rail exists to surface what an operator installed. Seventy
    // built-in kinds in it would bury the three that matter.
    setup();
    expect(await screen.findByText("3")).toBeInTheDocument();
    const nav = screen.getByRole("navigation");
    expect(within(nav).queryByRole("button", { name: "Pod" })).not.toBeInTheDocument();
  });

  it("expands to the cluster's own kinds, grouped by API group", async () => {
    const { user } = setup();
    await screen.findByText("3");

    await user.click(screen.getByRole("button", { name: "Expand CRDs" }));

    expect(screen.getByRole("button", { name: "Agent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Model" })).toBeInTheDocument();
    expect(screen.getByText("krypton.ai")).toBeInTheDocument();
    expect(screen.getByText("monitoring.coreos.com")).toBeInTheDocument();
  });

  it("selects a kind and switches the view to it", async () => {
    const { user, onSelect } = setup();
    await screen.findByText("3");
    await user.click(screen.getByRole("button", { name: "Expand CRDs" }));
    await user.click(screen.getByRole("button", { name: "Agent" }));

    expect(onSelect).toHaveBeenCalledWith({
      type: "kind",
      entry: expect.objectContaining({ label: "Agent", id: "krypton.ai/v1/Agent" }),
    });
  });

  it("clicking the section itself opens the index, not a kind", async () => {
    const { user, onSelect } = setup();
    await user.click(screen.getByRole("button", { name: /^CRDs/ }));
    expect(onSelect).toHaveBeenCalledWith({ type: "crds" });
  });

  it("reveals the selected kind without being asked", async () => {
    // Reaching a CRD from the index table should not leave the rail
    // shut over the thing that is on screen.
    setup({
      view: {
        type: "kind",
        entry: { id: "krypton.ai/v1/Agent", label: "Agent", gvk: CRDS[0] },
      },
    });
    expect(
      await screen.findByRole("button", { name: "Agent" }),
    ).toBeInTheDocument();
  });

  it("offers the everyday kinds without asking the cluster", () => {
    // Workloads, network, config and storage are a fixed list, so they
    // are on screen before discovery has answered — which is what makes
    // the rail usable on a slow cluster.
    setup();
    for (const label of ["Deployments", "Services", "Secrets", "Volume claims"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByText("Workloads")).toBeInTheDocument();
    expect(screen.getByText("Storage")).toBeInTheDocument();
  });

  it("reports a fixed kind as a kind view", async () => {
    const { user, onSelect } = setup();
    await user.click(screen.getByRole("button", { name: "Services" }));
    expect(onSelect).toHaveBeenCalledWith({
      type: "kind",
      entry: expect.objectContaining({ label: "Services" }),
    });
  });

  it("does not reach for the cluster before there is one", () => {
    setup({ cluster: null });
    expect(listApiResources).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^CRDs/ })).toBeDisabled();
  });

  it("collapses again without changing the view", async () => {
    const { user, onSelect } = setup();
    await screen.findByText("3");

    await user.click(screen.getByRole("button", { name: "Expand CRDs" }));
    expect(screen.getByRole("button", { name: "Agent" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Collapse CRDs" }));
    expect(screen.queryByRole("button", { name: "Agent" })).not.toBeInTheDocument();
    // The chevron is a disclosure control, not navigation.
    expect(onSelect).not.toHaveBeenCalled();
  });
});
