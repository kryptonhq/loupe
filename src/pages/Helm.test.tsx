import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Helm, ReleaseDetail as ReleaseDetailView } from "./Helm";
import {
  api,
  type ReleaseDetail,
  type ReleaseSummary,
} from "../lib/api";

// Helm releases, read out of the release Secrets rather than from the
// CLI. What matters on screen is which revision is live, what was
// actually overridden, and the notes — which are usually the only place
// a chart says how to reach what it installed.

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listHelmReleases: vi.fn(),
      getHelmRelease: vi.fn(),
      listNamespaces: vi.fn(),
    },
  };
});

const listHelmReleases = vi.mocked(api.listHelmReleases);
const getHelmRelease = vi.mocked(api.getHelmRelease);
const listNamespaces = vi.mocked(api.listNamespaces);

function summary(overrides: Partial<ReleaseSummary> = {}): ReleaseSummary {
  return {
    name: "prom",
    namespace: "monitoring",
    revision: 3,
    status: "deployed",
    chart: "kube-prometheus-stack-85.3.3",
    appVersion: "v0.87.0",
    updated: "2d",
    description: "Upgrade complete",
    ...overrides,
  };
}

function detail(overrides: Partial<ReleaseDetail> = {}): ReleaseDetail {
  return {
    name: "prom",
    namespace: "monitoring",
    revision: 3,
    status: "deployed",
    chart: "kube-prometheus-stack-85.3.3",
    chartName: "kube-prometheus-stack",
    chartVersion: "85.3.3",
    appVersion: "v0.87.0",
    updated: "2d",
    firstDeployed: "40d",
    description: "Upgrade complete",
    chartDescription: "collects Kubernetes manifests",
    home: "https://github.com/prometheus-operator",
    notes: "browse http://localhost:3000",
    values: "grafana:\n  enabled: true\n",
    manifest: "apiVersion: v1\nkind: Service\n",
    history: [
      {
        revision: 3,
        status: "deployed",
        chart: "kube-prometheus-stack-85.3.3",
        appVersion: "v0.87.0",
        updated: "2d",
        description: "Upgrade complete",
      },
      {
        revision: 2,
        status: "superseded",
        chart: "kube-prometheus-stack-85.0.0",
        appVersion: "v0.86.0",
        updated: "20d",
        description: "Upgrade complete",
      },
    ],
    ...overrides,
  };
}

const onOpen = vi.fn();
const onView = vi.fn();

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderHelm() {
  render(
    <QueryClientProvider client={client()}>
      <Helm onOpen={onOpen} view={{}} onView={onView} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

/// The detail view, rendered as the workspace renders it: on its own,
/// for one release, rather than nested inside the listing.
function renderRelease() {
  render(
    <QueryClientProvider client={client()}>
      <ReleaseDetailView namespace="monitoring" name="prom" onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  onOpen.mockReset();
  onView.mockReset();
  listHelmReleases.mockReset().mockResolvedValue([summary()]);
  getHelmRelease.mockReset().mockResolvedValue(detail());
  listNamespaces
    .mockReset()
    .mockResolvedValue([{ name: "monitoring", phase: "Active", age: "60d" }]);
});

describe("Helm release list", () => {
  it("lists releases the way helm list prints them", async () => {
    renderHelm();
    expect(await screen.findByText("prom")).toBeInTheDocument();
    expect(screen.getByText("kube-prometheus-stack-85.3.3")).toBeInTheDocument();
    expect(screen.getByText("v0.87.0")).toBeInTheDocument();
    expect(screen.getByText("deployed")).toBeInTheDocument();
  });

  it("explains an empty list rather than implying Helm is unused", async () => {
    // A cluster configured with HELM_DRIVER=configmap keeps its releases
    // somewhere Loupe does not read, and "no releases" would be wrong.
    listHelmReleases.mockResolvedValue([]);
    renderHelm();
    expect(await screen.findByText(/secret driver/)).toBeInTheDocument();
  });

  it("reports the namespace it was asked to narrow to", async () => {
    // The page reports; the workspace keeps it, so the filter survives
    // opening a release and coming back.
    const user = renderHelm();
    await screen.findByText("prom");

    await user.selectOptions(screen.getByRole("combobox"), "monitoring");
    await waitFor(() =>
      expect(onView).toHaveBeenCalledWith({ namespace: "monitoring" }),
    );
  });

  it("asks the cluster for the namespace the view names", async () => {
    render(
      <QueryClientProvider client={client()}>
        <Helm onOpen={onOpen} view={{ namespace: "monitoring" }} onView={onView} />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(listHelmReleases).toHaveBeenCalledWith("monitoring"),
    );
  });

  it("reports the release it was told to open", async () => {
    const user = renderHelm();
    await user.click(await screen.findByText("prom"));
    await waitFor(() =>
      expect(onOpen).toHaveBeenCalledWith(
        expect.objectContaining({ name: "prom", namespace: "monitoring" }),
        "here",
      ),
    );
  });

  it("surfaces a failure to list", async () => {
    listHelmReleases.mockRejectedValue({
      kind: "kubernetes",
      message: 'secrets is forbidden: User "dev" cannot list resource "secrets"',
    });
    renderHelm();
    expect(await screen.findByText(/forbidden/)).toBeInTheDocument();
  });
});

describe("Helm release detail", () => {
  it("reads the release it was pointed at", async () => {
    renderRelease();
    await waitFor(() => expect(getHelmRelease).toHaveBeenCalled());
    expect(getHelmRelease).toHaveBeenCalledWith("monitoring", "prom");
  });

  it("leads with the live revision", async () => {
    renderRelease();
    await waitFor(() => expect(getHelmRelease).toHaveBeenCalled());
    expect(await screen.findByText("rev 3")).toBeInTheDocument();
    expect(screen.getByText("kube-prometheus-stack")).toBeInTheDocument();
    expect(screen.getByText("85.3.3")).toBeInTheDocument();
  });

  it("shows what was overridden, not the chart's defaults", async () => {
    // `helm get values` makes the same distinction, and it is the one
    // that answers "what did we actually configure".
    const user = renderRelease();
    await waitFor(() => expect(getHelmRelease).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Values" }));

    expect(await screen.findByText(/grafana/)).toBeInTheDocument();
  });

  it("says so when a release runs the chart's defaults", async () => {
    // An empty YAML pane would read as a failure to load.
    getHelmRelease.mockResolvedValue(detail({ values: "" }));
    const user = renderRelease();
    await waitFor(() => expect(getHelmRelease).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Values" }));

    expect(
      await screen.findByText(/No values were overridden/),
    ).toBeInTheDocument();
  });

  it("renders the notes as written", async () => {
    // Usually the only place a chart says how to reach what it just
    // installed, and the line breaks in it are meaningful.
    const user = renderRelease();
    await waitFor(() => expect(getHelmRelease).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Notes" }));

    expect(await screen.findByText(/localhost:3000/)).toBeInTheDocument();
  });

  it("says so when a chart ships no notes", async () => {
    getHelmRelease.mockResolvedValue(detail({ notes: null }));
    const user = renderRelease();
    await waitFor(() => expect(getHelmRelease).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Notes" }));

    expect(await screen.findByText(/ships no notes/)).toBeInTheDocument();
  });

  it("reads its history backwards in time", async () => {
    // The way `helm history` prints it: the current revision at the top.
    const user = renderRelease();
    await waitFor(() => expect(getHelmRelease).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "History" }));

    expect(await screen.findByText("superseded")).toBeInTheDocument();
    const revisions = screen
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.textContent);
    expect(revisions[0]).toContain("3");
    expect(revisions[1]).toContain("2");
  });

  it("renders the manifest that was applied", async () => {
    const user = renderRelease();
    await waitFor(() => expect(getHelmRelease).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Manifest" }));

    expect(await screen.findByText(/Service/)).toBeInTheDocument();
  });
});
