import type { GvkRef } from "./api";
import { KIND_SECTIONS, type KindEntry } from "./kinds";

// What the main area can be showing.
//
// Every destination in the app is one of these, whether it arrived from
// the rail, from a row in a listing, or from following a related object.
// Making that one closed set is what lets navigation be held centrally:
// a history is a list of routes, and a tab is a history.
//
// Before this, each page held its own `selected` state, so opening an
// object replaced the listing with no way back and no way to hold two
// objects at once. The pages are now listings and detail views that
// report where they want to go; where that lands is decided here.

export type Route =
  | { type: "nodes" }
  | { type: "namespaces" }
  | { type: "pods" }
  | { type: "crds" }
  | { type: "helm" }
  | { type: "kind"; entry: KindEntry }
  | { type: "node"; name: string }
  | { type: "namespace"; name: string }
  | { type: "pod"; namespace: string; name: string }
  | { type: "release"; namespace: string; name: string }
  | {
      type: "object";
      resource: GvkRef;
      namespace: string | null;
      name: string;
    };

/// The route the app opens on, and what a new tab starts at when there
/// is nothing better to copy.
export const HOME: Route = { type: "nodes" };

/// How something was opened. Holding ⌘ or Ctrl asks for a tab of its
/// own, the way it does on a link, so a list can be fanned out into
/// several tabs without going back to it between each one.
export type OpenIntent = "here" | "newTab";

export function intentOf(e: {
  metaKey?: boolean;
  ctrlKey?: boolean;
}): OpenIntent {
  return e.metaKey || e.ctrlKey ? "newTab" : "here";
}

/// Identity. Two routes with the same key are the same destination, so
/// navigating to one you are already on is a no-op rather than a
/// duplicate history entry, and a row you have already opened can be
/// found in an existing tab instead of opening a second one.
export function routeKey(route: Route): string {
  switch (route.type) {
    case "kind":
      return `kind:${route.entry.id}`;
    case "node":
      return `node:${route.name}`;
    case "namespace":
      return `namespace:${route.name}`;
    case "pod":
      return `pod:${route.namespace}/${route.name}`;
    case "release":
      return `release:${route.namespace}/${route.name}`;
    case "object": {
      const { group, version, kind } = route.resource;
      return `object:${group}/${version}/${kind}/${route.namespace ?? ""}/${route.name}`;
    }
    default:
      return route.type;
  }
}

/// How a route reads in a tab and in the breadcrumb.
///
/// Objects are labelled by name alone rather than by kind/name: the tab
/// is narrow, and the name is the part that distinguishes one tab from
/// its neighbour. The kind is carried by the breadcrumb's earlier
/// crumbs and by the detail view's own header.
export function routeLabel(route: Route): string {
  switch (route.type) {
    case "nodes":
      return "Nodes";
    case "namespaces":
      return "Namespaces";
    case "pods":
      return "Pods";
    case "crds":
      return "CRDs";
    case "helm":
      return "Helm";
    case "kind":
      return route.entry.label;
    case "node":
    case "namespace":
    case "pod":
    case "release":
    case "object":
      return route.name;
  }
}

/// A longer form for tooltips and for the breadcrumb, where there is
/// room to say which namespace an object is in.
export function routeTitle(route: Route): string {
  switch (route.type) {
    case "pod":
    case "release":
      return `${route.namespace}/${route.name}`;
    case "object":
      return route.namespace
        ? `${route.resource.kind} ${route.namespace}/${route.name}`
        : `${route.resource.kind} ${route.name}`;
    case "node":
      return `Node ${route.name}`;
    case "namespace":
      return `Namespace ${route.name}`;
    default:
      return routeLabel(route);
  }
}

/// Whether a route shows one object rather than a listing. Detail views
/// get the navigation chrome; listings are already the top of a trail.
export function isDetail(route: Route): boolean {
  return (
    route.type === "node" ||
    route.type === "namespace" ||
    route.type === "pod" ||
    route.type === "release" ||
    route.type === "object"
  );
}

/// The rail's own entry for a kind, so a breadcrumb says "DaemonSets"
/// the way the rail does rather than "DaemonSet" the way the API does.
/// Falls back to the bare kind for anything not in the rail, which is
/// every custom resource.
function kindEntryFor(gvk: GvkRef): KindEntry {
  const id = `${gvk.group}/${gvk.version}/${gvk.kind}`;
  for (const section of KIND_SECTIONS) {
    const match = section.items.find((entry) => entry.id === id);
    if (match) return match;
  }
  return { id, label: gvk.kind, gvk };
}

/// One step in the breadcrumb.
export interface Crumb {
  label: string;
  /// The long form, for the tooltip.
  title: string;
  /// Where it goes, or null for the step you are already standing on.
  route: Route | null;
}

/// The breadcrumb for a route.
///
/// This describes where an object sits, not how you came to be looking
/// at it. Those are different questions and only one of them makes a
/// breadcrumb: a trail of visited routes reads "Nodes › Pods › some-pod
/// › Jobs › DaemonSets › some-daemonset", which is a record of wandering
/// and implies a containment that does not exist. Where you have been is
/// what the back and forward arrows are for.
///
/// So the crumbs are derived from the current route alone — its kind's
/// listing, its namespace, and itself.
export function crumbsFor(route: Route): Crumb[] {
  const at = (r: Route, current: boolean): Crumb => ({
    label: routeLabel(r),
    title: routeTitle(r),
    route: current ? null : r,
  });
  const here = at(route, true);
  const namespaceOf = (name: string) => at({ type: "namespace", name }, false);

  switch (route.type) {
    case "node":
      return [at({ type: "nodes" }, false), here];

    case "namespace":
      return [at({ type: "namespaces" }, false), here];

    case "pod":
      return [at({ type: "pods" }, false), namespaceOf(route.namespace), here];

    case "release":
      return [at({ type: "helm" }, false), namespaceOf(route.namespace), here];

    case "object": {
      const listing: Route = { type: "kind", entry: kindEntryFor(route.resource) };
      // Cluster-scoped objects have no namespace to sit in, and an empty
      // crumb between the kind and the name would only be noise.
      return route.namespace
        ? [at(listing, false), namespaceOf(route.namespace), here]
        : [at(listing, false), here];
    }

    default:
      // A listing is the top of its own hierarchy; there is nothing above
      // Pods to put in front of it.
      return [here];
  }
}

/// The listing a detail route belongs under, so opening an object from
/// the command palette still lands with a trail behind it rather than
/// at the top of an empty history.
export function parentOf(route: Route): Route | null {
  switch (route.type) {
    case "node":
      return { type: "nodes" };
    case "namespace":
      return { type: "namespaces" };
    case "pod":
      return { type: "pods" };
    case "release":
      return { type: "helm" };
    default:
      return null;
  }
}
