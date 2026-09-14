import { describe, expect, it } from "vitest";
import type { Problem, ProblemsSnapshot } from "./api";
import {
  badgeCount,
  formatSeconds,
  inNamespace,
  namespacesOf,
  problemAge,
  routeForProblem,
  settled,
} from "./problems";
import { routeKey, routeLabel } from "./routes";

function problem(overrides: Partial<Problem> = {}): Problem {
  return {
    id: "x",
    severity: "warning",
    category: "pods",
    target: { group: "", version: "v1", kind: "Pod", namespace: "shop", name: "api" },
    reason: "NotReady",
    message: "m",
    since: 100,
    count: null,
    ...overrides,
  };
}

function snapshot(problems: Problem[], states: string[] = ["ready"]): ProblemsSnapshot {
  return {
    problems,
    sources: states.map((state) => ({ source: "pods", category: "pods", state }) as ProblemsSnapshot["sources"][number]),
    generatedAt: 1000,
    graceSeconds: 120,
    restartThreshold: 5,
  };
}

describe("routeForProblem", () => {
  it("opens pods and nodes in their own views", () => {
    expect(routeForProblem(problem())).toEqual({ type: "pod", namespace: "shop", name: "api" });
    expect(
      routeForProblem(
        problem({ target: { group: "", version: "v1", kind: "Node", namespace: null, name: "worker-1" } }),
      ),
    ).toEqual({ type: "node", name: "worker-1" });
  });

  it("opens everything else, custom resources included, as an object", () => {
    expect(
      routeForProblem(
        problem({
          target: { group: "cert-manager.io", version: "v1", kind: "Certificate", namespace: "web", name: "tls" },
        }),
      ),
    ).toEqual({
      type: "object",
      resource: { group: "cert-manager.io", version: "v1", kind: "Certificate" },
      namespace: "web",
      name: "tls",
    });
  });

  it("has nowhere to go for a category Loupe could not check", () => {
    expect(routeForProblem(problem({ target: null, reason: "NotPermitted" }))).toBeNull();
  });
});

describe("problemAge", () => {
  it("measures on the core's clock and keeps ticking after the snapshot", () => {
    expect(problemAge(problem({ since: 100 }), 1000)).toBe(900);
    expect(problemAge(problem({ since: 100 }), 1000, 30)).toBe(930);
  });

  it("never reads as starting in the future", () => {
    expect(problemAge(problem({ since: 2000 }), 1000)).toBe(0);
  });

  it("has no age when the API gave no start", () => {
    expect(problemAge(problem({ since: null }), 1000)).toBeNull();
  });
});

describe("formatSeconds", () => {
  it("matches the app's other age columns", () => {
    expect(formatSeconds(45)).toBe("45s");
    expect(formatSeconds(120)).toBe("2m");
    expect(formatSeconds(7200)).toBe("2h");
    expect(formatSeconds(3 * 86_400)).toBe("3d");
  });
});

describe("inNamespace", () => {
  const shop = problem({ id: "shop" });
  const ml = problem({ id: "ml", target: { ...shop.target!, namespace: "ml" } });
  const node = problem({ id: "node", target: { group: "", version: "v1", kind: "Node", namespace: null, name: "n" } });
  const refused = problem({ id: "refused", target: null });

  it("keeps everything when no namespace is chosen", () => {
    expect(inNamespace([shop, ml, node, refused], "")).toHaveLength(4);
  });

  it("keeps cluster-scoped rows under any filter", () => {
    // A node that is not ready is a problem for every namespace.
    expect(inNamespace([shop, ml, node, refused], "ml").map((p) => p.id)).toEqual(["ml", "node", "refused"]);
  });
});

describe("badgeCount", () => {
  it("counts what is wrong, not what is merely noted", () => {
    const counts = badgeCount(
      snapshot([
        problem({ severity: "critical" }),
        problem({ severity: "warning" }),
        problem({ severity: "warning" }),
        problem({ severity: "info" }),
      ]),
    );
    expect(counts).toEqual({ critical: 1, warning: 2 });
  });

  it("is zero before there is anything", () => {
    expect(badgeCount(null)).toEqual({ critical: 0, warning: 0 });
  });
});

describe("settled", () => {
  it("waits for every source before an empty view can mean nothing is wrong", () => {
    expect(settled(null)).toBe(false);
    expect(settled(snapshot([], ["ready", "loading"]))).toBe(false);
    expect(settled(snapshot([], ["ready", "forbidden"]))).toBe(true);
  });
});

describe("namespacesOf", () => {
  it("lists each namespace once, sorted, ignoring cluster-scoped rows", () => {
    expect(
      namespacesOf([
        problem({ target: { ...problem().target!, namespace: "shop" } }),
        problem({ target: { ...problem().target!, namespace: "ml" } }),
        problem({ target: { ...problem().target!, namespace: "shop" } }),
        problem({ target: null }),
      ]),
    ).toEqual(["ml", "shop"]);
  });
});

describe("the problems route", () => {
  it("is a listing with a name of its own", () => {
    expect(routeLabel({ type: "problems" })).toBe("Problems");
    // Blind to the view, like every listing: a different namespace is
    // the same destination presented differently.
    expect(routeKey({ type: "problems", view: { namespace: "ml" } })).toBe(routeKey({ type: "problems" }));
  });
});
