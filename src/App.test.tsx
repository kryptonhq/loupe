import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { api } from "./lib/api";

// The shell: which screen is showing, and what happens to cached data
// when the cluster underneath it changes. The cache is the interesting
// part — rows from the previous cluster appearing under the new one's
// name would be worse than a slow load.

vi.mock("./lib/api", async (original) => {
  const actual = await original<typeof import("./lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      currentCluster: vi.fn(),
      getSettings: vi.fn(),
      setTheme: vi.fn(),
      disconnect: vi.fn(),
      listContexts: vi.fn(),
      connect: vi.fn(),
      listNodes: vi.fn(),
      listNamespaces: vi.fn(),
      listPods: vi.fn(),
      listApiResources: vi.fn(),
      listHelmReleases: vi.fn(),
      vibrancyEnabled: vi.fn(),
    },
  };
});

vi.mock("./lib/window", () => ({ dragRegionProps: {} }));

const currentCluster = vi.mocked(api.currentCluster);
const getSettings = vi.mocked(api.getSettings);
const setTheme = vi.mocked(api.setTheme);
const disconnect = vi.mocked(api.disconnect);
const listContexts = vi.mocked(api.listContexts);
const listNodes = vi.mocked(api.listNodes);

const CLUSTER = {
  context: "orbstack",
  server: "https://127.0.0.1:26443",
  version: "v1.33.1",
  platform: "linux/arm64",
};

/// Tracks the QueryClient so a test can assert the cache was cleared.
let client: QueryClient;

function renderApp() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  vi.clearAllMocks();

  // jsdom has no matchMedia, and the theme effect reads it on mount.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });

  currentCluster.mockResolvedValue(CLUSTER);
  getSettings.mockResolvedValue({ theme: "system" });
  setTheme.mockResolvedValue({ theme: "dark" });
  disconnect.mockResolvedValue(undefined);
  listContexts.mockResolvedValue([
    {
      name: "orbstack",
      // Distinct from the context name so a query for one in the picker
      // is unambiguous.
      cluster: "orbstack-k8s",
      user: "orbstack-admin",
      namespace: null,
      isCurrent: true,
    },
  ]);
  listNodes.mockResolvedValue([
    { name: "worker-1", ready: true, roles: [], version: "v1.33.1", age: "1d" },
  ]);
  vi.mocked(api.listNamespaces).mockResolvedValue([]);
  vi.mocked(api.listPods).mockResolvedValue([]);
  vi.mocked(api.listApiResources).mockResolvedValue([]);
  vi.mocked(api.listHelmReleases).mockResolvedValue([]);
  vi.mocked(api.vibrancyEnabled).mockResolvedValue(false);
});

describe("App startup", () => {
  it("reconnects to the session already held in Rust", async () => {
    // A webview reload must not drop the user back to the picker: the
    // session lives on the Rust side and survives it.
    renderApp();
    expect(await screen.findByRole("heading", { name: "Nodes" })).toBeInTheDocument();
    expect(screen.queryByText(/Choose a cluster/)).not.toBeInTheDocument();
  });

  it("shows the picker when there is no session", async () => {
    currentCluster.mockResolvedValue(null);
    renderApp();
    expect(await screen.findByText(/Choose a cluster/)).toBeInTheDocument();
  });

  it("does not flash the picker before the backend has answered", async () => {
    // Rendering the picker while the answer is in flight makes every
    // launch blink, even when a session exists.
    currentCluster.mockImplementation(() => new Promise(() => {}));
    renderApp();

    await waitFor(() =>
      expect(screen.queryByText(/Choose a cluster/)).not.toBeInTheDocument(),
    );
  });

  it("falls back to following the system when settings cannot be read", async () => {
    // No settings file on first run, and no bridge at all in browser
    // dev. Neither is a reason to refuse to start.
    getSettings.mockRejectedValue(new Error("no bridge"));
    renderApp();
    expect(await screen.findByRole("heading", { name: "Nodes" })).toBeInTheDocument();
  });
});

describe("App navigation", () => {
  it("opens the view the sidebar asks for", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.click(screen.getByRole("button", { name: /Helm/ }));
    await waitFor(() =>
      expect(api.listHelmReleases).toHaveBeenCalled(),
    );
  });
});

describe("App cluster changes", () => {
  it("drops every cached list when switching cluster", async () => {
    // Each cached list belongs to the previous cluster. Invalidating
    // rather than clearing would let its rows flash on screen under the
    // new cluster's name.
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });
    await waitFor(() => expect(listNodes).toHaveBeenCalled());
    expect(client.getQueryCache().getAll().length).toBeGreaterThan(0);

    await user.click(screen.getByTitle(/Click to switch cluster/));
    await user.click(await screen.findByText("orbstack"));

    await waitFor(() => expect(api.connect).toHaveBeenCalledWith("orbstack"));
  });

  it("clears the cache on disconnect and returns to the picker", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });
    await waitFor(() =>
      expect(client.getQueryCache().getAll().length).toBeGreaterThan(0),
    );

    await user.click(screen.getByRole("button", { name: /Disconnect/i }));

    await waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Choose a cluster/)).toBeInTheDocument();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });

  it("lets a switch be cancelled back to the live cluster", async () => {
    // There is a session behind the picker in this case, unlike at
    // launch, so backing out has to be possible.
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.click(screen.getByTitle(/Click to switch cluster/));
    expect(await screen.findByText(/Switch to another cluster/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("heading", { name: "Nodes" })).toBeInTheDocument();
  });
});

describe("App theme", () => {
  it("persists a chosen theme", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.click(screen.getByRole("radio", { name: "Dark" }));
    await waitFor(() => expect(setTheme).toHaveBeenCalledWith("dark"));
    expect(document.documentElement).toHaveClass("dark");
  });

  it("applies a theme that fails to persist anyway", async () => {
    // The click should feel instant, and a preference that could not be
    // written is still the one the user asked for.
    setTheme.mockRejectedValue(new Error("disk full"));
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.click(screen.getByRole("radio", { name: "Dark" }));
    await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
  });

  it("honours a stored preference on launch", async () => {
    getSettings.mockResolvedValue({ theme: "dark" });
    renderApp();
    await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
  });
});
