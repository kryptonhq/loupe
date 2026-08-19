import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
    // Listings hold a watch, and Tauri's own Channel reaches into webview
    // internals that do not exist here.
    Channel: class {
      onmessage?: (event: unknown) => void;
    },
    api: {
      ...actual.api,
      startWatch: vi.fn().mockResolvedValue(1),
      stopWatch: vi.fn().mockResolvedValue(true),
      getPod: vi.fn(),
      getObject: vi.fn(),
      listRelated: vi.fn(),
      listTable: vi.fn(),
      listEvents: vi.fn(),
      currentCluster: vi.fn(),
      getSettings: vi.fn(),
      setTheme: vi.fn(),
      setZoom: vi.fn(),
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
  document.documentElement.style.removeProperty("zoom");

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
  getSettings.mockResolvedValue({ theme: "system", recentContexts: [], pinnedContexts: [], zoom: 1 });
  setTheme.mockResolvedValue({ theme: "dark", recentContexts: [], pinnedContexts: [], zoom: 1 });
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
  vi.mocked(api.listNamespaces).mockResolvedValue([
    { name: "prod", phase: "Active", age: "120d" },
  ]);
  vi.mocked(api.listPods).mockResolvedValue([]);
  vi.mocked(api.listApiResources).mockResolvedValue([]);
  vi.mocked(api.listHelmReleases).mockResolvedValue([]);
  vi.mocked(api.vibrancyEnabled).mockResolvedValue(false);
  vi.mocked(api.setZoom).mockResolvedValue({
    theme: "system",
    recentContexts: [],
    pinnedContexts: [],
    zoom: 1,
  });
  vi.mocked(api.listEvents).mockResolvedValue([]);
  vi.mocked(api.listRelated).mockResolvedValue([]);
  vi.mocked(api.listPods).mockResolvedValue([
    {
      name: "web-abc",
      namespace: "prod",
      phase: "Running",
      node: "worker-1",
      ready: "1/1",
      restarts: 0,
      age: "3d",
    },
  ]);
  vi.mocked(api.getPod).mockResolvedValue({
    apiVersion: "v1",
    kind: "Pod",
    name: "web-abc",
    namespace: "prod",
    phase: "Running",
    node: "worker-1",
    podIp: "10.1.2.3",
    serviceAccount: "default",
    qosClass: "Burstable",
    age: "3d",
    labels: [],
    annotations: [],
    containers: [],
    initContainers: [],
    conditions: [],
    yaml: "apiVersion: v1\nkind: Pod\n",
  });
});

/// The namespace picker, told apart from the status bar's guard picker.
function namespacePicker() {
  return screen.getByRole("combobox", { name: /Namespace/i });
}

/// Open the pod list, then the one pod in it.
async function openPod(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Pods/ }));
  await user.click(await screen.findByText("web-abc"));
  return screen.findByRole("heading", { name: "web-abc" });
}

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

// Tabs and history. The mechanics are covered in lib/workspace.test.ts;
// what these assert is that the shell is wired to them — that opening an
// object keeps the listing it came from, that back retraces the trip,
// and that a tab is a piece of work you can leave and return to.
describe("App workspace", () => {
  it("says where an object sits, not how it was reached", async () => {
    // Reached by way of Nodes, but a pod does not live under Nodes. The
    // crumbs are derived from the pod itself: its listing, its
    // namespace, its name. Where you have been is the arrows' job.
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await openPod(user);

    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByTitle(/Go to Pods/)).toBeInTheDocument();
    expect(within(crumbs).getByTitle(/Go to Namespace prod/)).toBeInTheDocument();
    expect(within(crumbs).queryByTitle(/Nodes/)).not.toBeInTheDocument();
  });

  it("goes back to the listing and forward to the object again", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });
    await openPod(user);

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Pods" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Forward" }));
    expect(
      await screen.findByRole("heading", { name: "web-abc" }),
    ).toBeInTheDocument();
  });

  it("goes back on Escape as well as on the arrow", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });
    await openPod(user);

    await user.keyboard("{Escape}");
    expect(await screen.findByRole("heading", { name: "Pods" })).toBeInTheDocument();
  });

  it("goes to the listing an object belongs to from its crumb", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });
    await openPod(user);

    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    await user.click(within(crumbs).getByTitle(/Go to Pods/));

    expect(await screen.findByRole("heading", { name: "Pods" })).toBeInTheDocument();
  });

  it("hides the bar on a listing opened fresh, where it would only repeat the heading", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "Nodes" });
    expect(
      screen.queryByRole("navigation", { name: "Breadcrumb" }),
    ).not.toBeInTheDocument();
  });

  it("opens a row in its own tab when the modifier is held", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.click(screen.getByRole("button", { name: /Pods/ }));
    const row = await screen.findByText("web-abc");
    await user.keyboard("{Meta>}");
    await user.click(row);
    await user.keyboard("{/Meta}");

    await screen.findByRole("heading", { name: "web-abc" });
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("leaves the other tab where it was", async () => {
    // The point of a second tab: the first keeps its place, so going
    // back to it costs nothing.
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });
    await openPod(user);

    await user.keyboard("{Meta>}t{/Meta}");
    const [first, second] = screen.getAllByRole("tab");
    expect(second).toHaveAttribute("aria-selected", "true");

    await user.click(first);
    expect(
      await screen.findByRole("heading", { name: "web-abc" }),
    ).toBeInTheDocument();
  });

  it("closes a tab and shows its neighbour", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.keyboard("{Meta>}t{/Meta}");
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    await user.keyboard("{Meta>}w{/Meta}");
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
    expect(screen.getByRole("heading", { name: "Nodes" })).toBeInTheDocument();
  });

  it("never leaves the window with no tab at all", async () => {
    // A window with nothing open has nowhere to render and nothing to
    // click, so the last tab resets rather than closing.
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });
    await openPod(user);

    await user.keyboard("{Meta>}w{/Meta}");

    expect(await screen.findByRole("heading", { name: "Nodes" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("reaches a tab by number", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });
    await openPod(user);
    await user.keyboard("{Meta>}t{/Meta}");

    await user.keyboard("{Meta>}1{/Meta}");
    expect(
      await screen.findByRole("heading", { name: "web-abc" }),
    ).toBeInTheDocument();
  });

  it("names each tab after what it is showing", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });
    expect(screen.getByRole("tab")).toHaveTextContent("Nodes");

    await openPod(user);
    expect(screen.getByRole("tab")).toHaveTextContent("web-abc");
  });

  it("follows a related object into another kind, and retraces the chain", async () => {
    // The trip the Related tab exists for: from a Deployment to the
    // ConfigMap it mounts. Going back has to land on the Deployment
    // rather than on the listing, or every step of the chain is lost at
    // once.
    vi.mocked(api.listTable).mockResolvedValue({
      namespaced: true,
      columns: [{ name: "Name", priority: 0, description: null }],
      rows: [{ name: "web", namespace: "prod", cells: ["web"] }],
      continueToken: null,
      remaining: null,
    });
    vi.mocked(api.getObject).mockImplementation(
      async (resource, namespace, name) =>
        ({
          apiVersion: `${resource.group}/${resource.version}`,
          kind: resource.kind,
          name,
          namespace,
          age: "6d",
          status: "Ready",
          labels: [],
          annotations: [],
          conditions: [],
          editable: true,
          yaml: `kind: ${resource.kind}\n`,
        }) as never,
    );
    vi.mocked(api.listRelated).mockResolvedValue([
      {
        relation: "uses",
        group: "",
        version: "v1",
        kind: "ConfigMap",
        name: "web-config",
        namespace: "prod",
        reachable: true,
        detail: "volume config",
      },
    ]);

    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.click(screen.getByRole("button", { name: "Deployments" }));
    await user.click(await screen.findByText("web"));
    await screen.findByRole("heading", { name: "web" });

    await user.click(await screen.findByRole("button", { name: "Related" }));
    await user.click(await screen.findByRole("button", { name: /web-config/ }));
    await screen.findByRole("heading", { name: "web-config" });

    // Back to the Deployment, not to the Deployments listing.
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "web" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(
      await screen.findByRole("heading", { name: "Deployments" }),
    ).toBeInTheDocument();
  });

  it("keeps the namespace filter across opening a pod and coming back", async () => {
    // The filter used to live in the listing, and a listing unmounts the
    // moment you open a row from it — so drilling into a pod and pressing
    // back handed you every namespace again and a dropdown to re-pick.
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.click(screen.getByRole("button", { name: /Pods/ }));
    await screen.findByText("web-abc");
    await user.selectOptions(namespacePicker(), "prod");
    await waitFor(() => expect(api.listPods).toHaveBeenCalledWith("prod"));

    await user.click(await screen.findByText("web-abc"));
    await screen.findByRole("heading", { name: "web-abc" });

    await user.click(screen.getByRole("button", { name: "Back" }));

    await screen.findByRole("heading", { name: "Pods" });
    await waitFor(() =>
      expect(namespacePicker()).toHaveValue("prod"),
    );
  });

  it("keeps a filter change out of the history", async () => {
    // Scoping a listing is the same destination shown differently. If it
    // pushed, back would mean "undo my last keystroke" and walking out of
    // a listing would take one press per filter you had tried.
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.click(screen.getByRole("button", { name: /Pods/ }));
    await screen.findByText("web-abc");
    await user.selectOptions(namespacePicker(), "prod");
    await waitFor(() => expect(api.listPods).toHaveBeenCalledWith("prod"));

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Nodes" })).toBeInTheDocument();
  });

  it("gives each tab its own filter", async () => {
    // Two tabs on the same listing scoped to different namespaces is the
    // point of a tab being a piece of work rather than a bookmark.
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.click(screen.getByRole("button", { name: /Pods/ }));
    await screen.findByText("web-abc");
    await user.selectOptions(namespacePicker(), "prod");
    await waitFor(() => expect(namespacePicker()).toHaveValue("prod"));

    await user.keyboard("{Meta>}t{/Meta}");
    await screen.findByRole("heading", { name: "Pods" });
    await user.selectOptions(namespacePicker(), "");

    await user.keyboard("{Meta>}1{/Meta}");
    await waitFor(() => expect(namespacePicker()).toHaveValue("prod"));
  });

  it("starts a fresh workspace when the cluster changes", async () => {
    // Tabs name objects in the cluster being left. One pointing at a pod
    // that does not exist here is worse than starting clean.
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });
    await openPod(user);
    await user.keyboard("{Meta>}t{/Meta}");
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    await user.click(screen.getByTitle(/Click to switch cluster/));
    await user.click(await screen.findByText("orbstack"));

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
    expect(screen.getByRole("heading", { name: "Nodes" })).toBeInTheDocument();
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

    // No cluster data may survive, or rows from the cluster we just left
    // flash under the next one's heading. Asserted on the data rather
    // than on the entries: a still-mounted query re-registers an empty
    // entry immediately, which is harmless. The kubeconfig's context
    // list is not cluster data and is expected to stay — the picker and
    // the command palette both need it.
    const stale = client
      .getQueryCache()
      .getAll()
      .filter((query) => query.queryKey[0] !== "contexts")
      .filter((query) => query.state.data !== undefined)
      .map((query) => query.queryKey);
    expect(stale).toEqual([]);
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

// Keyboard-first navigation. The point is that a session can run
// without the mouse, so these go through the keyboard.
describe("App command palette", () => {
  it("opens on the platform shortcut", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.keyboard("{Meta>}k{/Meta}");
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
  });

  it("opens on Ctrl-K too", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
  });

  it("navigates to a kind without the mouse", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(await screen.findByLabelText("Command"), "helm");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(api.listHelmReleases).toHaveBeenCalled());
    // And the palette gets out of the way of what it just opened.
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
  });

  it("offers the other contexts as somewhere to switch to", async () => {
    listContexts.mockResolvedValue([
      { name: "orbstack", cluster: "orbstack-k8s", user: "u", namespace: null, isCurrent: true },
      { name: "eks-prod", cluster: "eks", user: "u", namespace: null, isCurrent: false },
    ]);

    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(await screen.findByLabelText("Command"), "eks-prod");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(api.connect).toHaveBeenCalledWith("eks-prod"));
  });

  it("does not offer the cluster already connected", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(await screen.findByLabelText("Command"), "orbstack");

    // "orbstack" is the live context; switching to it is not a command.
    expect(screen.queryByText("orbstack-k8s")).not.toBeInTheDocument();
  });

  it("closes on a second press of the shortcut", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.keyboard("{Meta>}k{/Meta}");
    await screen.findByRole("dialog", { name: "Command palette" });
    await user.keyboard("{Meta>}k{/Meta}");

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Command palette" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("shows the shortcut sheet on ?", async () => {
    // A shortcut nobody can find is a shortcut nobody uses.
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.keyboard("?");
    expect(
      await screen.findByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeInTheDocument();
  });

  it("lets ? be typed into a filter rather than opening the sheet", async () => {
    // Otherwise no search box in the app can contain a question mark.
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.click(screen.getByPlaceholderText("Search…"));
    await user.keyboard("?");

    expect(
      screen.queryByRole("dialog", { name: "Keyboard shortcuts" }),
    ).not.toBeInTheDocument();
  });
});

// Zoom is an accessibility control: 13px is too small for a good number
// of people to read for an hour, and the alternative is resizing every
// other window on the machine to fix one.
describe("App zoom", () => {
  it("scales the interface, and steps back to normal", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.keyboard("{Meta>}={/Meta}");
    await waitFor(() =>
      expect(document.documentElement.style.zoom).toBe("1.1"),
    );

    await user.keyboard("{Meta>}0{/Meta}");
    // Removed rather than set to 1, so the ordinary case leaves no trace.
    await waitFor(() => expect(document.documentElement.style.zoom).toBe(""));
  });

  it("shrinks as well as grows", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.keyboard("{Meta>}-{/Meta}");
    await waitFor(() => expect(document.documentElement.style.zoom).toBe("0.9"));
  });

  it("remembers the size across launches", async () => {
    // Someone who needs 150% needs it every time. Having to say so at
    // every start is the same as not having the control.
    getSettings.mockResolvedValue({
      theme: "system",
      recentContexts: [],
      pinnedContexts: [],
      zoom: 1.5,
    });
    renderApp();
    await waitFor(() => expect(document.documentElement.style.zoom).toBe("1.5"));
  });

  it("persists a size the moment it changes", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.keyboard("{Meta>}={/Meta}");
    await waitFor(() => expect(api.setZoom).toHaveBeenCalledWith(1.1));
  });

  it("applies a size that failed to persist anyway", async () => {
    // Same rule as the theme: the keystroke should land, and a size that
    // could not be written is still the one that was asked for.
    vi.mocked(api.setZoom).mockRejectedValue(new Error("disk full"));
    const user = renderApp();
    await screen.findByRole("heading", { name: "Nodes" });

    await user.keyboard("{Meta>}={/Meta}");
    await waitFor(() =>
      expect(document.documentElement.style.zoom).toBe("1.1"),
    );
  });

  it("ignores a stored size it cannot make sense of", async () => {
    getSettings.mockResolvedValue({
      theme: "system",
      recentContexts: [],
      pinnedContexts: [],
      zoom: 40,
    });
    renderApp();
    await screen.findByRole("heading", { name: "Nodes" });
    // Clamped to the largest step the layout has been looked at in.
    await waitFor(() => expect(document.documentElement.style.zoom).toBe("2"));
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
    getSettings.mockResolvedValue({ theme: "dark", recentContexts: [], pinnedContexts: [], zoom: 1 });
    renderApp();
    await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
  });
});
