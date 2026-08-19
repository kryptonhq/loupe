import { describe, expect, it } from "vitest";
import type { Route } from "./routes";
import {
  activeTab,
  canGoBack,
  canGoForward,
  closeActiveTab,
  closeTab,
  currentRoute,
  goBack,
  goForward,
  navigate,
  newWorkspace,
  openInNewTab,
  selectIndex,
  selectTab,
} from "./workspace";

const pods: Route = { type: "pods" };
const nodes: Route = { type: "nodes" };
const helm: Route = { type: "helm" };

function pod(name: string): Route {
  return { type: "pod", namespace: "default", name };
}

function labels(ws: ReturnType<typeof newWorkspace>) {
  const tab = activeTab(ws);
  return tab.history
    .slice(0, tab.index + 1)
    .map((r) => (r.type === "pod" ? r.name : r.type));
}

describe("newWorkspace", () => {
  it("starts with one tab on the home route", () => {
    const ws = newWorkspace();
    expect(ws.tabs).toHaveLength(1);
    expect(currentRoute(ws)).toEqual(nodes);
  });
});

describe("navigate", () => {
  it("pushes onto the active tab's history", () => {
    let ws = newWorkspace();
    ws = navigate(ws, pods);
    ws = navigate(ws, pod("api-1"));
    expect(labels(ws)).toEqual(["nodes", "pods", "api-1"]);
    expect(currentRoute(ws)).toEqual(pod("api-1"));
  });

  it("ignores a navigation to the route already on screen", () => {
    let ws = newWorkspace();
    ws = navigate(ws, pods);
    const before = ws;
    ws = navigate(ws, { type: "pods" });
    expect(ws).toBe(before);
  });

  it("drops forward history when navigating after going back", () => {
    let ws = newWorkspace();
    ws = navigate(ws, pods);
    ws = navigate(ws, pod("api-1"));
    ws = goBack(ws);
    ws = navigate(ws, helm);
    expect(labels(ws)).toEqual(["nodes", "pods", "helm"]);
    expect(canGoForward(activeTab(ws))).toBe(false);
  });

  it("leaves other tabs alone", () => {
    let ws = newWorkspace();
    ws = openInNewTab(ws, pods);
    ws = navigate(ws, helm);
    expect(ws.tabs[0].history).toEqual([nodes]);
  });
});

describe("back and forward", () => {
  it("moves the cursor without losing either side", () => {
    let ws = newWorkspace();
    ws = navigate(ws, pods);
    ws = navigate(ws, pod("api-1"));

    ws = goBack(ws);
    expect(currentRoute(ws)).toEqual(pods);
    expect(canGoBack(activeTab(ws))).toBe(true);
    expect(canGoForward(activeTab(ws))).toBe(true);

    ws = goForward(ws);
    expect(currentRoute(ws)).toEqual(pod("api-1"));
    expect(activeTab(ws).history).toHaveLength(3);
  });

  it("does nothing at either end", () => {
    const ws = newWorkspace();
    expect(goBack(ws)).toBe(ws);
    expect(goForward(ws)).toBe(ws);
  });
});

describe("openInNewTab", () => {
  it("adds a tab and makes it active", () => {
    let ws = newWorkspace();
    ws = openInNewTab(ws, pods);
    expect(ws.tabs).toHaveLength(2);
    expect(ws.active).toBe(ws.tabs[1].id);
    expect(currentRoute(ws)).toEqual(pods);
  });

  it("seeds a trail so the new tab can go back", () => {
    let ws = newWorkspace();
    ws = openInNewTab(ws, pod("api-1"), pods);
    expect(canGoBack(activeTab(ws))).toBe(true);
    expect(labels(ws)).toEqual(["pods", "api-1"]);
  });

  it("gives every tab a distinct id", () => {
    let ws = newWorkspace();
    ws = openInNewTab(ws, pods);
    ws = openInNewTab(ws, helm);
    expect(new Set(ws.tabs.map((t) => t.id)).size).toBe(3);
  });
});

describe("selectTab", () => {
  it("shows the named tab", () => {
    let ws = newWorkspace();
    const first = ws.tabs[0].id;
    ws = openInNewTab(ws, pods);
    ws = selectTab(ws, first);
    expect(currentRoute(ws)).toEqual(nodes);
  });

  it("ignores a tab that is not open", () => {
    const ws = newWorkspace();
    expect(selectTab(ws, "gone")).toBe(ws);
  });

  it("selects by position, and ignores one past the end", () => {
    let ws = newWorkspace();
    ws = openInNewTab(ws, pods);
    expect(currentRoute(selectIndex(ws, 0))).toEqual(nodes);
    expect(selectIndex(ws, 9)).toBe(ws);
  });
});

describe("closeTab", () => {
  it("hands focus to the right-hand neighbour", () => {
    let ws = newWorkspace();
    ws = openInNewTab(ws, pods);
    ws = openInNewTab(ws, helm);
    ws = selectTab(ws, ws.tabs[1].id);
    ws = closeActiveTab(ws);
    expect(ws.tabs).toHaveLength(2);
    expect(currentRoute(ws)).toEqual(helm);
  });

  it("falls back to the left when the last tab is closed", () => {
    let ws = newWorkspace();
    ws = openInNewTab(ws, pods);
    ws = closeActiveTab(ws);
    expect(currentRoute(ws)).toEqual(nodes);
  });

  it("keeps the active tab when a different one is closed", () => {
    let ws = newWorkspace();
    const first = ws.tabs[0].id;
    ws = openInNewTab(ws, pods);
    ws = closeTab(ws, first);
    expect(ws.tabs).toHaveLength(1);
    expect(currentRoute(ws)).toEqual(pods);
  });

  it("resets rather than empties the last tab", () => {
    let ws = newWorkspace();
    ws = navigate(ws, helm);
    ws = closeActiveTab(ws);
    expect(ws.tabs).toHaveLength(1);
    expect(currentRoute(ws)).toEqual(nodes);
    expect(canGoBack(activeTab(ws))).toBe(false);
  });

  it("ignores a tab that is not open", () => {
    let ws = newWorkspace();
    ws = openInNewTab(ws, pods);
    expect(closeTab(ws, "gone")).toBe(ws);
  });
});
