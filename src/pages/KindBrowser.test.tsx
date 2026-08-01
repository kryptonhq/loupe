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
    },
  };
});

const listTable = vi.mocked(api.listTable);
const getObject = vi.mocked(api.getObject);
const listNamespaces = vi.mocked(api.listNamespaces);

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
});
