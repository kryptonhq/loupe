import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EventsTable } from "./EventsTable";
import { api, type EventView } from "../lib/api";

// The Events tab has two modes, and the difference between them is the
// whole reason it is one component: events *about* one object, and every
// event *in* a namespace. The second needs to say which object each row
// is about; the first must not, where it would repeat the page title on
// every row.

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, listEvents: vi.fn(), listNamespaceEvents: vi.fn() },
  };
});

const listEvents = vi.mocked(api.listEvents);
const listNamespaceEvents = vi.mocked(api.listNamespaceEvents);

function event(overrides: Partial<EventView> = {}): EventView {
  return {
    type: "Warning",
    reason: "BackOff",
    message: "Back-off restarting failed container",
    count: 12,
    age: "3m",
    source: "kubelet",
    object: "Pod/coredns-abc",
    ...overrides,
  };
}

function renderEvents(props: { namespace: string; name?: string }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <EventsTable {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listEvents.mockReset();
  listNamespaceEvents.mockReset();
  listEvents.mockResolvedValue([event()]);
  listNamespaceEvents.mockResolvedValue([event()]);
});

describe("EventsTable", () => {
  it("filters to one object when given a name", async () => {
    renderEvents({ namespace: "kube-system", name: "coredns-abc" });
    expect(await screen.findByText(/Back-off/)).toBeInTheDocument();

    expect(listEvents).toHaveBeenCalledWith("kube-system", "coredns-abc");
    expect(listNamespaceEvents).not.toHaveBeenCalled();
  });

  it("omits the subject column on one object's own events", async () => {
    // It would repeat the page title on every row.
    renderEvents({ namespace: "kube-system", name: "coredns-abc" });
    await screen.findByText(/Back-off/);
    expect(
      screen.queryByRole("columnheader", { name: "Subject" }),
    ).not.toBeInTheDocument();
  });

  it("shows every event in the namespace when given no name", async () => {
    // A namespace object almost never has events of its own. What an
    // operator wants from a namespace is what is going wrong inside it.
    renderEvents({ namespace: "kube-system" });
    expect(await screen.findByText(/Back-off/)).toBeInTheDocument();

    expect(listNamespaceEvents).toHaveBeenCalledWith("kube-system");
    expect(listEvents).not.toHaveBeenCalled();
  });

  it("names the subject in the namespace-wide view", async () => {
    // With a hundred events from a hundred pods, which object it is
    // about is the first thing you read.
    renderEvents({ namespace: "kube-system" });
    await screen.findByText(/Back-off/);
    expect(
      screen.getByRole("columnheader", { name: "Subject" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Pod/coredns-abc")).toBeInTheDocument();
  });

  it("fills in a count for an event that fired once", async () => {
    // The API omits `count` for a single occurrence. An empty cell reads
    // as missing data rather than as "once".
    listEvents.mockResolvedValue([event({ count: null })]);
    renderEvents({ namespace: "kube-system", name: "coredns-abc" });
    await screen.findByText(/Back-off/);
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("renders an em dash for the fields an event may omit", async () => {
    listEvents.mockResolvedValue([
      event({ reason: null, message: null, age: null }),
    ]);
    renderEvents({ namespace: "kube-system", name: "coredns-abc" });
    expect((await screen.findAllByText("—")).length).toBeGreaterThan(0);
  });

  it("explains an empty list rather than looking broken", async () => {
    // Events expire after about an hour, so empty is a normal result and
    // saying why saves the user looking for a bug.
    listEvents.mockResolvedValue([]);
    renderEvents({ namespace: "kube-system", name: "coredns-abc" });
    expect(await screen.findByText(/discards them/)).toBeInTheDocument();
  });

  it("surfaces a failure to list", async () => {
    listEvents.mockRejectedValue({
      kind: "kubernetes",
      message: 'events is forbidden: User "dev" cannot list resource "events"',
    });
    renderEvents({ namespace: "kube-system", name: "coredns-abc" });
    expect(await screen.findByText(/forbidden/)).toBeInTheDocument();
  });
});
