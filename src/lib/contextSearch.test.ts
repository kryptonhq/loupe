import { describe, expect, it } from "vitest";
import {
  indexContexts,
  partitionContexts,
  rankContexts,
  type SearchableContext,
} from "./contextSearch";

function ctx(name: string, cluster = name, namespace: string | null = null) {
  return { name, cluster, namespace };
}

function search(contexts: SearchableContext[], query: string) {
  return rankContexts(indexContexts(contexts), query).map((r) => r.context.name);
}

describe("rankContexts", () => {
  it("returns everything, in order, for an empty query", () => {
    const all = [ctx("b"), ctx("a")];
    expect(search(all, "")).toEqual(["b", "a"]);
    expect(search(all, "   ")).toEqual(["b", "a"]);
  });

  it("puts an exact name first", () => {
    // Typing a cluster's full name and getting it thirtieth is the
    // specific failure that makes a long list feel broken.
    const all = [ctx("prod-eu"), ctx("prod"), ctx("prod-us")];
    expect(search(all, "prod")[0]).toBe("prod");
  });

  it("prefers a name prefix over a match in the middle", () => {
    const all = [ctx("eks-prod-1"), ctx("prod-1")];
    expect(search(all, "prod")).toEqual(["prod-1", "eks-prod-1"]);
  });

  it("prefers a shorter name when both are prefixes", () => {
    // "prod" is more likely what was meant than "prod-canary-eu-west-3".
    const all = [ctx("prod-canary-eu-west-3"), ctx("prod-a")];
    expect(search(all, "prod")[0]).toBe("prod-a");
  });

  it("prefers a match in the name over one in the cluster", () => {
    const all = [ctx("alpha", "prod-cluster"), ctx("prod-thing", "other")];
    expect(search(all, "prod")[0]).toBe("prod-thing");
  });

  it("searches the cluster and namespace too", () => {
    const all = [ctx("one", "arn:aws:eks:eu-west-1:cluster/payments")];
    expect(search(all, "payments")).toEqual(["one"]);
    expect(search([ctx("two", "c", "kube-system")], "kube-system")).toEqual(["two"]);
  });

  it("falls back to a subsequence match", () => {
    // Enough to find a long generated name from its initials.
    const all = [ctx("gke-europe-west1-production")];
    expect(search(all, "gkeprd")).toEqual(["gke-europe-west1-production"]);
  });

  it("ranks a real match above a subsequence one", () => {
    const all = [ctx("gke-europe-west1-production"), ctx("prod")];
    expect(search(all, "prod")[0]).toBe("prod");
  });

  it("narrows on every term rather than widening", () => {
    // "prod eu" should mean both, the way anyone expects it to.
    const all = [ctx("prod-eu"), ctx("prod-us"), ctx("staging-eu")];
    expect(search(all, "prod eu")).toEqual(["prod-eu"]);
  });

  it("ignores case", () => {
    expect(search([ctx("Prod-EU")], "prod-eu")).toEqual(["Prod-EU"]);
  });

  it("returns nothing when a term matches nothing", () => {
    expect(search([ctx("prod")], "prod nonexistent")).toEqual([]);
  });

  it("orders ties by name so the list does not shuffle", () => {
    const all = [ctx("prod-z"), ctx("prod-a"), ctx("prod-m")];
    expect(search(all, "prod")).toEqual(["prod-a", "prod-m", "prod-z"]);
  });

  it("stays responsive on a kubeconfig with thousands of contexts", () => {
    // The size that prompted this: an org with one context per cluster.
    const all = Array.from({ length: 10_000 }, (_, i) =>
      ctx(`gke-region-${i % 40}-cluster-${i}`, `projects/p/locations/l/clusters/c${i}`),
    );
    const indexed = indexContexts(all);

    const started = performance.now();
    for (const query of ["p", "pr", "pro", "prod", "region-7"]) {
      rankContexts(indexed, query);
    }
    const elapsed = performance.now() - started;

    // Five keystrokes over 10,000 contexts. Generous enough not to be
    // flaky on a loaded machine, tight enough to catch a return to
    // building the haystack per keystroke.
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe("partitionContexts", () => {
  const ranked = [ctx("a"), ctx("b"), ctx("c"), ctx("d")].map((context) => ({
    context,
    score: 1,
  }));

  it("separates pinned, recent and the rest", () => {
    const { pinned, recent, rest } = partitionContexts(ranked, ["c"], ["b"]);
    expect(pinned.map((c) => c.name)).toEqual(["c"]);
    expect(recent.map((c) => c.name)).toEqual(["b"]);
    expect(rest.map((c) => c.name)).toEqual(["a", "d"]);
  });

  it("keeps recents in the order they were used, not by relevance", () => {
    // Most recent first is the whole point; re-sorting by score would
    // throw away the only signal that says which cluster you are on.
    const { recent } = partitionContexts(ranked, [], ["d", "a"]);
    expect(recent.map((c) => c.name)).toEqual(["d", "a"]);
  });

  it("keeps pinned in the user's own order", () => {
    const { pinned } = partitionContexts(ranked, ["d", "a"], []);
    expect(pinned.map((c) => c.name)).toEqual(["d", "a"]);
  });

  it("counts a context that is both pinned and recent only as pinned", () => {
    // Otherwise it appears twice, and clicking one of them looks broken.
    const { pinned, recent } = partitionContexts(ranked, ["b"], ["b", "c"]);
    expect(pinned.map((c) => c.name)).toEqual(["b"]);
    expect(recent.map((c) => c.name)).toEqual(["c"]);
  });

  it("ignores pinned or recent names no longer in the kubeconfig", () => {
    // Contexts get removed. A stale entry must not produce a row that
    // cannot be connected to.
    const { pinned, recent, rest } = partitionContexts(ranked, ["gone"], ["also-gone"]);
    expect(pinned).toEqual([]);
    expect(recent).toEqual([]);
    expect(rest).toHaveLength(4);
  });

  it("drops entries the query filtered out", () => {
    // A pinned context that does not match the search should not
    // reappear above the results that do.
    const filtered = [{ context: ctx("a"), score: 1 }];
    const { pinned, rest } = partitionContexts(filtered, ["c"], []);
    expect(pinned).toEqual([]);
    expect(rest.map((c) => c.name)).toEqual(["a"]);
  });
});
