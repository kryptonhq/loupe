import { describe, expect, it } from "vitest";
import {
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
