// One kind's listing, with the columns the API server printed.
//
// Following an object out of here — into its ReplicaSet, its Deployment,
// the ConfigMap it mounts — is the workspace's job now, and is covered
// where that lives: the mechanics in lib/workspace.test.ts, and the
// whole trip through the UI in App.test.tsx. What is left to cover here
// is the table.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KindBrowser } from "./KindBrowser";
import { api, type ResourceTable } from "../lib/api";
import type { KindEntry } from "../lib/kinds";
import type { ListView } from "../lib/routes";

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    // Listings hold a watch now, and Tauri's own Channel reaches into
    // webview internals that do not exist here.
    Channel: class {
      onmessage?: (event: unknown) => void;
    },
    api: {
      ...actual.api,
      startWatch: vi.fn().mockResolvedValue(1),
      stopWatch: vi.fn().mockResolvedValue(true),
      listTable: vi.fn(),
      listNamespaces: vi.fn(),
    },
  };
});

const listTable = vi.mocked(api.listTable);
const listNamespaces = vi.mocked(api.listNamespaces);

const onOpen = vi.fn();
const onView = vi.fn();

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

function renderBrowser(entry: KindEntry, listView: ListView = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <KindBrowser
        entry={entry}
        onOpen={onOpen}
        view={listView}
        onView={onView}
      />
    </QueryClientProvider>,
  );
  return {
    user: userEvent.setup(),
    switchTo: (next: KindEntry) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <KindBrowser entry={next} onOpen={onOpen} view={{}} onView={onView} />
        </QueryClientProvider>,
      ),
  };
}

beforeEach(() => {
  onOpen.mockReset();
  onView.mockReset();
  listTable.mockReset();
  listNamespaces.mockReset();

  listTable.mockResolvedValue(table("mcp-hello"));
  listNamespaces.mockResolvedValue([]);
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
    expect(onView).toHaveBeenCalledWith({ wide: true });
  });

  it("shows the wide columns when the view asks for them", async () => {
    renderBrowser(AGENT, { wide: true });
    await screen.findByText("mcp-hello");
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

  it("reports the row it was told to open", async () => {
    const { user } = renderBrowser(AGENT);
    await user.click(await screen.findByText("mcp-hello"));

    await waitFor(() =>
      expect(onOpen).toHaveBeenCalledWith(
        expect.objectContaining({ name: "mcp-hello", namespace: "agents" }),
        "here",
      ),
    );
  });

  it("shows the new kind's own rows when the kind changes underneath it", async () => {
    // An Agent named mcp-hello is not a Model named mcp-hello, and a
    // listing that carried the old rows across would be showing one
    // kind's objects under another's heading.
    const { switchTo } = renderBrowser(AGENT);
    await screen.findByText("mcp-hello");

    listTable.mockResolvedValue(table("qwen2-0-5b"));
    switchTo(MODEL);

    expect(await screen.findByText("qwen2-0-5b")).toBeInTheDocument();
    expect(screen.queryByText("mcp-hello")).not.toBeInTheDocument();
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
});
