import { describe, expect, it } from "vitest";
import {
  crumbsFor,
  isDetail,
  parentOf,
  routeKey,
  routeLabel,
  routeTitle,
  type Route,
} from "./routes";

const entry = {
  id: "apps/v1/Deployment",
  label: "Deployments",
  gvk: { group: "apps", version: "v1", kind: "Deployment" },
};

describe("routeKey", () => {
  it("is the same for two routes naming the same destination", () => {
    const a: Route = { type: "pod", namespace: "kube-system", name: "coredns" };
    const b: Route = { type: "pod", namespace: "kube-system", name: "coredns" };
    expect(routeKey(a)).toBe(routeKey(b));
  });

  it("separates the same name in two namespaces", () => {
    const a: Route = { type: "pod", namespace: "a", name: "api" };
    const b: Route = { type: "pod", namespace: "b", name: "api" };
    expect(routeKey(a)).not.toBe(routeKey(b));
  });

  it("separates the same name in two kinds", () => {
    const a: Route = {
      type: "object",
      resource: { group: "", version: "v1", kind: "Service" },
      namespace: "default",
      name: "api",
    };
    const b: Route = {
      type: "object",
      resource: { group: "apps", version: "v1", kind: "Deployment" },
      namespace: "default",
      name: "api",
    };
    expect(routeKey(a)).not.toBe(routeKey(b));
  });

  it("separates a listing from a cluster-scoped object of the same name", () => {
    expect(routeKey({ type: "nodes" })).not.toBe(
      routeKey({ type: "node", name: "nodes" }),
    );
  });
});

describe("routeLabel", () => {
  it("names a listing", () => {
    expect(routeLabel({ type: "pods" })).toBe("Pods");
    expect(routeLabel({ type: "kind", entry })).toBe("Deployments");
  });

  it("names an object by name alone, because a tab is narrow", () => {
    expect(routeLabel({ type: "pod", namespace: "kube-system", name: "coredns" })).toBe(
      "coredns",
    );
  });
});

describe("routeTitle", () => {
  it("qualifies a namespaced object", () => {
    expect(routeTitle({ type: "pod", namespace: "kube-system", name: "coredns" })).toBe(
      "kube-system/coredns",
    );
  });

  it("leaves a cluster-scoped object unqualified", () => {
    expect(
      routeTitle({
        type: "object",
        resource: { group: "", version: "v1", kind: "PersistentVolume" },
        namespace: null,
        name: "pv-1",
      }),
    ).toBe("PersistentVolume pv-1");
  });
});

describe("isDetail", () => {
  it("is true for one object and false for a listing", () => {
    expect(isDetail({ type: "pod", namespace: "a", name: "b" })).toBe(true);
    expect(isDetail({ type: "kind", entry })).toBe(false);
  });
});

describe("parentOf", () => {
  it("gives a detail route its listing", () => {
    expect(parentOf({ type: "pod", namespace: "a", name: "b" })).toEqual({
      type: "pods",
    });
    expect(parentOf({ type: "node", name: "n" })).toEqual({ type: "nodes" });
  });

  it("gives a listing nothing to sit under", () => {
    expect(parentOf({ type: "pods" })).toBeNull();
  });
});

describe("crumbsFor", () => {
  /// Labels top to bottom, with the one you are standing on marked.
  function crumbs(route: Route) {
    return crumbsFor(route).map((c) => (c.route ? c.label : `[${c.label}]`));
  }

  it("puts an object under its kind and its namespace", () => {
    expect(
      crumbs({
        type: "object",
        resource: { group: "apps", version: "v1", kind: "DaemonSet" },
        namespace: "monitoring",
        name: "prom-node-exporter",
      }),
    ).toEqual(["DaemonSets", "monitoring", "[prom-node-exporter]"]);
  });

  it("says nothing about how you got there", () => {
    // The bug this replaced: crumbs were the tab's visited history, so a
    // DaemonSet reached by way of a pod and a job listing read
    // "Nodes › Pods › some-pod › Jobs › DaemonSets › some-daemonset" —
    // a record of wandering, implying a containment that is not real.
    // The same object has the same crumbs however it was reached.
    const route: Route = {
      type: "object",
      resource: { group: "apps", version: "v1", kind: "DaemonSet" },
      namespace: "monitoring",
      name: "prom-node-exporter",
    };
    expect(crumbs(route)).toHaveLength(3);
  });

  it("uses the rail's plural for a built-in kind", () => {
    // "DaemonSets", the way the rail says it, rather than the API's
    // singular "DaemonSet".
    const [kind] = crumbsFor({
      type: "object",
      resource: { group: "apps", version: "v1", kind: "DaemonSet" },
      namespace: "monitoring",
      name: "x",
    });
    expect(kind.label).toBe("DaemonSets");
    expect(kind.route).toEqual({
      type: "kind",
      entry: expect.objectContaining({ id: "apps/v1/DaemonSet" }),
    });
  });

  it("falls back to the bare kind for a custom resource", () => {
    const [kind] = crumbsFor({
      type: "object",
      resource: { group: "krypton.ai", version: "v1alpha1", kind: "Agent" },
      namespace: "agents",
      name: "mcp-hello",
    });
    expect(kind.label).toBe("Agent");
  });

  it("leaves out the namespace for a cluster-scoped object", () => {
    expect(
      crumbs({
        type: "object",
        resource: { group: "", version: "v1", kind: "PersistentVolume" },
        namespace: null,
        name: "pv-1",
      }),
      // "Volumes" because PersistentVolume is in the rail; the point
      // here is the missing namespace crumb, not the label.
    ).toEqual(["Volumes", "[pv-1]"]);
  });

  it("puts a pod under Pods and its namespace", () => {
    expect(crumbs({ type: "pod", namespace: "prod", name: "web-abc" })).toEqual([
      "Pods",
      "prod",
      "[web-abc]",
    ]);
  });

  it("puts a node under Nodes, which has no namespace", () => {
    expect(crumbs({ type: "node", name: "worker-1" })).toEqual([
      "Nodes",
      "[worker-1]",
    ]);
  });

  it("puts a release under Helm", () => {
    expect(
      crumbs({ type: "release", namespace: "monitoring", name: "prom" }),
    ).toEqual(["Helm", "monitoring", "[prom]"]);
  });

  it("gives a listing one crumb, because nothing sits above it", () => {
    expect(crumbs({ type: "pods" })).toEqual(["[Pods]"]);
    expect(crumbs({ type: "kind", entry })).toEqual(["[Deployments]"]);
  });

  it("never makes the last crumb a link", () => {
    for (const route of [
      { type: "pods" } as Route,
      { type: "pod", namespace: "a", name: "b" } as Route,
      { type: "node", name: "n" } as Route,
    ]) {
      const all = crumbsFor(route);
      expect(all[all.length - 1].route).toBeNull();
    }
  });
});
