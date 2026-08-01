import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Crds } from "./Crds";
import { api, type ApiResourceInfo, type GvkRef } from "../lib/api";

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listObjects: vi.fn(),
      getObject: vi.fn(),
      listNamespaces: vi.fn(),
    },
  };
});

const listObjects = vi.mocked(api.listObjects);
const getObject = vi.mocked(api.getObject);
const listNamespaces = vi.mocked(api.listNamespaces);

function kind(name: string): ApiResourceInfo {
  return {
    group: "krypton.ai",
    version: "v1alpha1",
    kind: name,
    plural: name.toLowerCase() + "s",
    apiVersion: "krypton.ai/v1alpha1",
    namespaced: true,
    verbs: ["get", "list", "update"],
    custom: true,
  };
}

const AGENT = kind("Agent");
const MODEL = kind("Model");

// Both kinds have an object called mcp-hello — the collision that makes
// carrying a selection across a kind switch produce a 404 rather than
// just the wrong page.
const OBJECTS = [
  { name: "mcp-hello", namespace: "agents", age: "65d", status: "Ready" },
];

function renderCrds(resource: ApiResourceInfo) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <Crds resource={resource} onSelectKind={vi.fn()} />
    </QueryClientProvider>,
  );
  return {
    user: userEvent.setup(),
    switchTo: (next: ApiResourceInfo) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <Crds resource={next} onSelectKind={vi.fn()} />
        </QueryClientProvider>,
      ),
  };
}

beforeEach(() => {
  listObjects.mockReset();
  getObject.mockReset();
  listNamespaces.mockReset();

  listObjects.mockResolvedValue(OBJECTS);
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

describe("Crds", () => {
  it("opens an object from the list", async () => {
    const { user } = renderCrds(AGENT);
    await user.click(await screen.findByText("mcp-hello"));

    await waitFor(() => expect(getObject).toHaveBeenCalled());
    expect(getObject.mock.calls[0][0].kind).toBe("Agent");
  });

  it("drops the open object when the kind changes underneath it", async () => {
    // The bug this guards: an Agent named mcp-hello stayed selected when
    // the sidebar switched to Model, and the detail view went looking
    // for a Model of the same name. There usually isn't one, so the page
    // rendered a 404 instead of Model's object list.
    const { user, switchTo } = renderCrds(AGENT);
    await user.click(await screen.findByText("mcp-hello"));
    await waitFor(() => expect(getObject).toHaveBeenCalled());

    switchTo(MODEL);

    // Back to a listing, not a detail page.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Model" })).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /Back to/ }),
    ).not.toBeInTheDocument();

    // And nothing went looking for the old name under the new kind.
    expect(
      getObject.mock.calls.some(([resource]) => resource.kind === "Model"),
    ).toBe(false);
  });

  it("lists the new kind's own objects after the switch", async () => {
    const { switchTo } = renderCrds(AGENT);
    await screen.findByText("mcp-hello");

    listObjects.mockResolvedValue([
      { name: "qwen2-0-5b", namespace: "models", age: "3d", status: "Ready" },
    ]);
    switchTo(MODEL);

    expect(await screen.findByText("qwen2-0-5b")).toBeInTheDocument();
  });
});
