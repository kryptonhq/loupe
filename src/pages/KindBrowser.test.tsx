// Cross-kind navigation is what the Related tab is for: from a
// Deployment you reach its ReplicaSet, from there its Pods, and from a
// Pod the ConfigMap it mounts. The listing stays where it was.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KindBrowser } from "./KindBrowser";
import { api, type GvkRef, type ResourceTable } from "../lib/api";
import type { KindEntry } from "../lib/kinds";

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listTable: vi.fn(),
      getObject: vi.fn(),
      listNamespaces: vi.fn(),
      listRelated: vi.fn(),
    },
  };
});

const listTable = vi.mocked(api.listTable);
const getObject = vi.mocked(api.getObject);
const listNamespaces = vi.mocked(api.listNamespaces);
const listRelated = vi.mocked(api.listRelated);

function kind(name: string): KindEntry {
  return {
    id: `krypton.ai/v1alpha1/${name}`,
    label: name,
    gvk: { group: "krypton.ai", version: "v1alpha1", kind: name },
  };
}

const AGENT = kind("Agent");
const MODEL = kind("Model");

/// A table shaped the way the API server sends one, including a
/// wide-only column.
function table(rowName: string): ResourceTable {
  return {
    namespaced: true,
    columns: [
      { name: "Name", priority: 0, description: null },
      { name: "Phase", priority: 0, description: null },
      { name: "Selector", priority: 1, description: "label selector" },
    ],
    rows: [
      { name: rowName, namespace: "agents", cells: [rowName, "Ready", "app=x"] },
    ],
    // One page, and the last one.
    continueToken: null,
    remaining: null,
  };
}

function renderBrowser(entry: KindEntry) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <KindBrowser entry={entry} />
    </QueryClientProvider>,
  );
  return {
    user: userEvent.setup(),
    switchTo: (next: KindEntry) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <KindBrowser entry={next} />
        </QueryClientProvider>,
      ),
  };
}

beforeEach(() => {
  listTable.mockReset();
  getObject.mockReset();
  listNamespaces.mockReset();
  listRelated.mockReset();
  listRelated.mockResolvedValue([]);

  listTable.mockResolvedValue(table("mcp-hello"));
  listNamespaces.mockResolvedValue([]);
  getObject.mockImplementation(async (resource: GvkRef, namespace, name) => ({
    apiVersion: `${resource.group}/${resource.version}`,
    kind: resource.kind,
    name,
    namespace,
    age: "65d",
    status: "Ready",
    labels: [],
    annotations: [],
    conditions: [],
    editable: true,
    yaml: `kind: ${resource.kind}\n`,
  }));
});

describe("KindBrowser", () => {
  it("renders the columns the server printed", async () => {
    renderBrowser(AGENT);
    expect(await screen.findByText("mcp-hello")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Phase" })).toBeInTheDocument();
  });

  it("holds back the wide-only columns until asked", async () => {
    // kubectl keeps these for -o wide because Selector and Images are
    // long enough to squeeze everything else off the pane.
    const { user } = renderBrowser(AGENT);
    await screen.findByText("mcp-hello");
    expect(
      screen.queryByRole("columnheader", { name: "Selector" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /wide/i }));
    expect(
      screen.getByRole("columnheader", { name: "Selector" }),
    ).toBeInTheDocument();
  });

  it("adds a namespace column the server does not send", async () => {
    // A cluster-wide listing has to say where each object lives, and no
    // server-printed table includes it.
    renderBrowser(AGENT);
    await screen.findByText("mcp-hello");
    expect(
      screen.getByRole("columnheader", { name: "Namespace" }),
    ).toBeInTheDocument();
  });

  it("opens an object from the listing", async () => {
    const { user } = renderBrowser(AGENT);
    await user.click(await screen.findByText("mcp-hello"));

    await waitFor(() => expect(getObject).toHaveBeenCalled());
    expect(getObject.mock.calls[0][0].kind).toBe("Agent");
  });

  it("drops the open object when the kind changes underneath it", async () => {
    // An Agent named mcp-hello is not a Model named mcp-hello. Carrying
    // the selection across sends the detail view after an object that
    // does not exist, and the pane renders a 404.
    const { user, switchTo } = renderBrowser(AGENT);
    await user.click(await screen.findByText("mcp-hello"));
    await waitFor(() => expect(getObject).toHaveBeenCalled());

    listTable.mockResolvedValue(table("qwen2-0-5b"));
    switchTo(MODEL);

    // Back to a listing, showing the new kind's own objects.
    expect(await screen.findByText("qwen2-0-5b")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Back to/ }),
    ).not.toBeInTheDocument();
    expect(
      getObject.mock.calls.some(([resource]) => resource.kind === "Model"),
    ).toBe(false);
  });

  it("asks for one page rather than the whole cluster", async () => {
    // Time to first row should follow the page size, not the size of the
    // cluster. Asking for everything meant 20,000 objects crossed the
    // IPC boundary before the first fifty could render.
    renderBrowser(AGENT);
    await screen.findByText("mcp-hello");

    const [, , limit, cursor] = listTable.mock.calls[0];
    expect(limit).toBeGreaterThan(0);
    expect(cursor ?? null).toBeNull();
  });

  it("fetches the next page with the cursor the server gave it", async () => {
    // The token is opaque: handed back exactly as received.
    listTable.mockResolvedValueOnce({
      ...table("mcp-hello"),
      continueToken: "eyJ2IjoibWV0YSJ9",
      remaining: 900,
    });

    const { user } = renderBrowser(AGENT);
    await user.click(await screen.findByRole("button", { name: "Load more" }));

    await waitFor(() => expect(listTable).toHaveBeenCalledTimes(2));
    expect(listTable.mock.calls[1][3]).toBe("eyJ2IjoibWV0YSJ9");
  });

  it("shows rows from every page that has been loaded", async () => {
    listTable.mockResolvedValueOnce({
      ...table("first-page-agent"),
      continueToken: "cursor",
      remaining: 1,
    });
    listTable.mockResolvedValueOnce(table("second-page-agent"));

    const { user } = renderBrowser(AGENT);
    await user.click(await screen.findByRole("button", { name: "Load more" }));

    expect(await screen.findByText("second-page-agent")).toBeInTheDocument();
    // The first page is still there; pages accumulate rather than replace.
    expect(screen.getByText("first-page-agent")).toBeInTheDocument();
  });

  it("follows a related object into a different kind", async () => {
    // The whole point of the Related tab. The listing stays on Agents;
    // the detail view moves to the ConfigMap.
    listRelated.mockResolvedValue([
      {
        relation: "uses",
        group: "",
        version: "v1",
        kind: "ConfigMap",
        name: "agent-config",
        namespace: "agents",
        reachable: true,
        detail: "volume config",
      },
    ]);

    const { user } = renderBrowser(AGENT);
    await user.click(await screen.findByText("mcp-hello"));
    await waitFor(() => expect(getObject).toHaveBeenCalled());

    await user.click(await screen.findByRole("button", { name: "Related" }));
    await user.click(await screen.findByRole("button", { name: /agent-config/ }));

    await waitFor(() =>
      expect(
        getObject.mock.calls.some(([resource]) => resource.kind === "ConfigMap"),
      ).toBe(true),
    );
  });

  it("goes back to where it was followed from, not to the listing", async () => {
    // Following a chain and then closing should retrace it, or the back
    // button loses everything you navigated through.
    listRelated.mockResolvedValue([
      {
        relation: "uses",
        group: "",
        version: "v1",
        kind: "ConfigMap",
        name: "agent-config",
        namespace: "agents",
        reachable: true,
        detail: null,
      },
    ]);

    const { user } = renderBrowser(AGENT);
    await user.click(await screen.findByText("mcp-hello"));
    await user.click(await screen.findByRole("button", { name: "Related" }));
    await user.click(await screen.findByRole("button", { name: /agent-config/ }));
    await screen.findByRole("button", { name: "Back to mcp-hello" });

    await user.click(screen.getByRole("button", { name: "Back to mcp-hello" }));

    // Back at the Agent, not at the Agents listing.
    expect(
      await screen.findByRole("button", { name: "Back to agent" }),
    ).toBeInTheDocument();
  });
});
