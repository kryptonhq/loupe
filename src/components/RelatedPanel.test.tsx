import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RelatedPanel } from "./RelatedPanel";
import { api, type RelatedObject } from "../lib/api";

// The Related tab is the answer to "why a GUI rather than a TUI":
// following a graph, rather than running `kubectl get -o yaml` and
// matching selectors by eye. What is asserted here is that the edges are
// grouped so they can be read, that they are followable, and that a
// reference the user cannot resolve is shown rather than quietly
// dropped — "you cannot see what owns this" is a useful answer.

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return { ...actual, api: { ...actual.api, listRelated: vi.fn() } };
});

const listRelated = vi.mocked(api.listRelated);

function related(over: Partial<RelatedObject> = {}): RelatedObject {
  return {
    relation: "ownedBy",
    group: "apps",
    version: "v1",
    kind: "ReplicaSet",
    name: "api-7d9",
    namespace: "payments",
    reachable: true,
    detail: null,
    ...over,
  };
}

function setup() {
  const onOpen = vi.fn();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RelatedPanel
        target={{
          resource: { group: "", version: "v1", kind: "Pod" },
          namespace: "payments",
          name: "api-7d9-xk2",
        }}
        onOpen={onOpen}
      />
    </QueryClientProvider>,
  );
  return { onOpen, user: userEvent.setup() };
}

beforeEach(() => {
  listRelated.mockReset();
  listRelated.mockResolvedValue([]);
});

describe("RelatedPanel", () => {
  it("asks for what the object is connected to", async () => {
    setup();
    await waitFor(() =>
      expect(listRelated).toHaveBeenCalledWith(
        { group: "", version: "v1", kind: "Pod" },
        "payments",
        "api-7d9-xk2",
      ),
    );
  });

  it("groups edges by what makes them related", async () => {
    // Twelve rows in one undifferentiated list is not navigation. The
    // heading is what makes the direction legible.
    listRelated.mockResolvedValue([
      related({ relation: "ownedBy", kind: "ReplicaSet", name: "api-7d9" }),
      related({ relation: "uses", kind: "ConfigMap", name: "api-config" }),
      related({ relation: "selectedBy", kind: "Service", name: "api" }),
    ]);

    setup();

    expect(await screen.findByText("Owned by")).toBeInTheDocument();
    expect(screen.getByText("Uses")).toBeInTheDocument();
    expect(screen.getByText("Selected by")).toBeInTheDocument();
  });

  it("shows no heading for a relation with nothing in it", async () => {
    listRelated.mockResolvedValue([related({ relation: "ownedBy" })]);
    setup();

    await screen.findByText("Owned by");
    expect(screen.queryByText("Uses")).not.toBeInTheDocument();
    expect(screen.queryByText("Selects")).not.toBeInTheDocument();
  });

  it("opens the object that was clicked", async () => {
    const target = related({ kind: "Deployment", name: "api" });
    listRelated.mockResolvedValue([target]);

    const { user, onOpen } = setup();
    await user.click(await screen.findByRole("button", { name: /api/ }));

    expect(onOpen).toHaveBeenCalledWith(target);
  });

  it("says how a referenced object is used", async () => {
    // "db-creds" alone does not tell you where to look; "$DB_PASSWORD in
    // api" does.
    listRelated.mockResolvedValue([
      related({
        relation: "uses",
        kind: "Secret",
        name: "db-creds",
        detail: "$DB_PASSWORD in api",
      }),
    ]);

    setup();
    expect(await screen.findByText("$DB_PASSWORD in api")).toBeInTheDocument();
  });

  it("shows an unreadable reference rather than dropping it", async () => {
    // A dangling owner reference is usually the explanation for whatever
    // the user is looking at, and an RBAC denial is worth stating.
    listRelated.mockResolvedValue([
      related({ name: "deleted-rs", reachable: false }),
    ]);

    setup();
    expect(await screen.findByText("deleted-rs")).toBeInTheDocument();
    expect(screen.getByText("unreadable")).toBeInTheDocument();
  });

  it("does not offer an unreadable reference as something to open", async () => {
    // A link that cannot go anywhere reads as a broken app.
    listRelated.mockResolvedValue([
      related({ name: "deleted-rs", reachable: false }),
    ]);

    setup();
    await screen.findByText("deleted-rs");
    expect(
      screen.queryByRole("button", { name: /deleted-rs/ }),
    ).not.toBeInTheDocument();
  });

  it("says so when an object is connected to nothing", async () => {
    setup();
    expect(
      await screen.findByText(/Nothing references this object/),
    ).toBeInTheDocument();
  });

  it("surfaces a failure rather than showing an empty graph", async () => {
    // "No relations" and "the request failed" mean very different things
    // and must not look the same.
    listRelated.mockRejectedValue({
      kind: "kubernetes",
      message: "pods is forbidden",
    });

    setup();
    expect(await screen.findByText(/forbidden/)).toBeInTheDocument();
  });
});
