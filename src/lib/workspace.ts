import { HOME, routeKey, type Route } from "./routes";

// Tabs, and the history behind each one.
//
// A tab is a history and a position in it, exactly like a browser's:
// navigating pushes and truncates whatever was ahead, back and forward
// move the cursor without losing either side. That is what makes
// following a chain — pod, its ReplicaSet, the Deployment above it, the
// Service that selects it — recoverable rather than a one-way trip.
//
// Everything here is a pure function over the workspace, so the whole
// navigation model is testable without rendering anything. `App` holds
// one of these in state and does nothing to it that is not in this file.

export interface Tab {
  id: string;
  /// Oldest first. Never empty.
  history: Route[];
  /// Index into `history` of what the tab is showing.
  index: number;
}

export interface Workspace {
  tabs: Tab[];
  /// Id of the tab on screen. Always names a tab in `tabs`.
  active: string;
  /// Source of tab ids. Held in the workspace rather than in a module
  /// counter so the same sequence of calls always produces the same
  /// workspace, which is what makes this testable.
  nextId: number;
}

/// How many history entries a tab keeps. Long enough that no real
/// session reaches it, bounded so a long-lived window cannot grow
/// without limit.
const HISTORY_LIMIT = 50;

export function newWorkspace(route: Route = HOME): Workspace {
  return {
    tabs: [{ id: "t1", history: [route], index: 0 }],
    active: "t1",
    nextId: 2,
  };
}

export function activeTab(ws: Workspace): Tab {
  // The invariant that `active` names a tab is maintained by every
  // function here; the fallback is so a corrupted workspace renders
  // something rather than throwing in a render.
  return ws.tabs.find((t) => t.id === ws.active) ?? ws.tabs[0];
}

export function currentRoute(ws: Workspace): Route {
  const tab = activeTab(ws);
  return tab.history[tab.index];
}

export function canGoBack(tab: Tab): boolean {
  return tab.index > 0;
}

export function canGoForward(tab: Tab): boolean {
  return tab.index < tab.history.length - 1;
}

function replaceTab(ws: Workspace, id: string, next: Tab): Workspace {
  return { ...ws, tabs: ws.tabs.map((t) => (t.id === id ? next : t)) };
}

/// Go to a route in the active tab, pushing it onto the history.
///
/// Navigating to what is already on screen does nothing, so clicking
/// the rail entry you are already on does not fill the history with
/// repeats of one listing.
export function navigate(ws: Workspace, route: Route): Workspace {
  const tab = activeTab(ws);
  if (routeKey(tab.history[tab.index]) === routeKey(route)) return ws;

  // Anything ahead of the cursor is dropped: having gone back and then
  // somewhere new, the branch you left is no longer reachable forward.
  const history = [...tab.history.slice(0, tab.index + 1), route];
  const trimmed = history.slice(-HISTORY_LIMIT);
  return replaceTab(ws, tab.id, {
    ...tab,
    history: trimmed,
    index: trimmed.length - 1,
  });
}

/// Swap what the active tab is showing, without adding to its history.
///
/// For a change to how a listing is presented — the namespace it is
/// scoped to, the text filtering it, the column it is sorted by — rather
/// than a move somewhere new. Pushing those would fill the history with
/// one listing at every filter it has ever had, and make back mean "undo
/// my last keystroke".
export function replace(ws: Workspace, route: Route): Workspace {
  const tab = activeTab(ws);
  const history = [...tab.history];
  history[tab.index] = route;
  return replaceTab(ws, tab.id, { ...tab, history });
}

/// Open a route in a tab of its own and make it active.
///
/// `under` seeds the history so the new tab has a trail — opening a pod
/// from the palette lands with Pods behind it, and back means something
/// immediately rather than being dead on arrival.
export function openInNewTab(
  ws: Workspace,
  route: Route,
  under: Route | null = null,
): Workspace {
  const id = `t${ws.nextId}`;
  const history = under ? [under, route] : [route];
  const tab: Tab = { id, history, index: history.length - 1 };
  return { ...ws, tabs: [...ws.tabs, tab], active: id, nextId: ws.nextId + 1 };
}

/// Show an existing tab.
export function selectTab(ws: Workspace, id: string): Workspace {
  return ws.tabs.some((t) => t.id === id) ? { ...ws, active: id } : ws;
}

export function selectIndex(ws: Workspace, i: number): Workspace {
  const tab = ws.tabs[i];
  return tab ? { ...ws, active: tab.id } : ws;
}

/// Close a tab.
///
/// The last tab is never closed — it is reset to the home route
/// instead. A window with no tabs has nowhere to render and nothing to
/// click, and every editor that allows it has to invent an empty state
/// to fill the hole.
export function closeTab(ws: Workspace, id: string): Workspace {
  if (ws.tabs.length === 1) {
    return ws.tabs[0].id === id ? newWorkspace() : ws;
  }

  const i = ws.tabs.findIndex((t) => t.id === id);
  if (i < 0) return ws;

  const tabs = ws.tabs.filter((t) => t.id !== id);
  // Closing the active tab hands focus to its right-hand neighbour,
  // falling back to the left when it was last — the behaviour every
  // editor has, and the one that keeps a run of closes moving in one
  // direction instead of jumping back to the start.
  const active =
    ws.active === id ? (tabs[i] ?? tabs[tabs.length - 1]).id : ws.active;
  return { ...ws, tabs, active };
}

export function closeActiveTab(ws: Workspace): Workspace {
  return closeTab(ws, ws.active);
}

export function goBack(ws: Workspace): Workspace {
  const tab = activeTab(ws);
  if (!canGoBack(tab)) return ws;
  return replaceTab(ws, tab.id, { ...tab, index: tab.index - 1 });
}

export function goForward(ws: Workspace): Workspace {
  const tab = activeTab(ws);
  if (!canGoForward(tab)) return ws;
  return replaceTab(ws, tab.id, { ...tab, index: tab.index + 1 });
}

