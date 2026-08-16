import { describe, expect, it, vi } from "vitest";
import { groupCommands, rankCommands, type Command } from "./palette";

function command(over: Partial<Command> = {}): Command {
  return {
    id: over.label ?? "id",
    group: "Go to",
    label: "Deployments",
    run: vi.fn(),
    ...over,
  };
}

function search(commands: Command[], query: string) {
  return rankCommands(commands, query).map((c) => c.label);
}

describe("rankCommands", () => {
  it("returns everything, in order, for an empty query", () => {
    const all = [command({ label: "b" }), command({ label: "a" })];
    expect(search(all, "")).toEqual(["b", "a"]);
  });

  it("puts an exact match first", () => {
    const all = [
      command({ label: "Pods on node" }),
      command({ label: "Pods" }),
      command({ label: "Pod disruption budgets" }),
    ];
    expect(search(all, "pods")[0]).toBe("Pods");
  });

  it("prefers a prefix over a match in the middle", () => {
    const all = [command({ label: "Stateful sets" }), command({ label: "Sets" })];
    expect(search(all, "set")).toEqual(["Sets", "Stateful sets"]);
  });

  it("prefers the shorter of two prefixes", () => {
    const all = [
      command({ label: "Config maps and secrets" }),
      command({ label: "Config maps" }),
    ];
    expect(search(all, "config")[0]).toBe("Config maps");
  });

  it("matches hidden keywords without needing to show them", () => {
    // "deploy" finding Deployments is worth having; putting the word on
    // screen is not.
    const all = [command({ label: "Deployments", keywords: "deploy workload" })];
    expect(search(all, "deploy")).toEqual(["Deployments"]);
  });

  it("matches the hint as well as the label", () => {
    const all = [command({ label: "Agents", hint: "krypton.ai/v1alpha1" })];
    expect(search(all, "krypton")).toEqual(["Agents"]);
  });

  it("ranks a label match above a hint match", () => {
    const all = [
      command({ label: "Something else", hint: "pods" }),
      command({ label: "Pods" }),
    ];
    expect(search(all, "pods")[0]).toBe("Pods");
  });

  it("falls back to a subsequence, which is what makes initials work", () => {
    // "pvc" is p…v…c through "Persistent volume claims", so typing the
    // initials of a long kind name finds it.
    const all = [command({ label: "Persistent volume claims" })];
    expect(search(all, "pvc")).toEqual(["Persistent volume claims"]);
    expect(search(all, "prsist")).toEqual(["Persistent volume claims"]);
  });

  it("does not match a subsequence in the wrong order", () => {
    const all = [command({ label: "Persistent volume claims" })];
    expect(search(all, "cvp")).toEqual([]);
  });

  it("narrows on every term rather than widening", () => {
    const all = [
      command({ label: "Pods", hint: "prod" }),
      command({ label: "Pods", hint: "staging", id: "b" }),
      command({ label: "Services", hint: "prod", id: "c" }),
    ];
    expect(rankCommands(all, "pods prod")).toHaveLength(1);
  });

  it("returns nothing when a term matches nothing", () => {
    expect(search([command({ label: "Pods" })], "pods zzzz")).toEqual([]);
  });

  it("ignores case", () => {
    expect(search([command({ label: "Pods" })], "PODS")).toEqual(["Pods"]);
  });

  it("breaks ties by label so the list does not shuffle", () => {
    const all = [
      command({ label: "Zeta", id: "z" }),
      command({ label: "Alpha", id: "a" }),
    ];
    // Both match a subsequence equally; order must be stable.
    expect(search(all, "a")).toEqual(["Alpha", "Zeta"]);
  });
});

describe("groupCommands", () => {
  it("keeps groups in the order given, not by score", () => {
    // A palette whose sections jump around as you type is harder to use
    // than one whose sections stay put.
    const grouped = groupCommands(
      [
        command({ group: "Action", label: "Disconnect", id: "1" }),
        command({ group: "Go to", label: "Pods", id: "2" }),
      ],
      ["Go to", "Action"],
    );
    expect(grouped.map((g) => g.group)).toEqual(["Go to", "Action"]);
  });

  it("keeps each group's own order", () => {
    const grouped = groupCommands(
      [
        command({ group: "Go to", label: "Second", id: "1" }),
        command({ group: "Go to", label: "First", id: "2" }),
      ],
      ["Go to"],
    );
    expect(grouped[0].commands.map((c) => c.label)).toEqual(["Second", "First"]);
  });

  it("omits a group with nothing in it", () => {
    const grouped = groupCommands(
      [command({ group: "Go to", label: "Pods" })],
      ["Go to", "Cluster", "Action"],
    );
    expect(grouped).toHaveLength(1);
  });

  it("still shows a group the caller did not order", () => {
    // Dropping commands because their group was not listed would be a
    // silent loss of function.
    const grouped = groupCommands(
      [command({ group: "Unexpected", label: "Thing" })],
      ["Go to"],
    );
    expect(grouped.map((g) => g.group)).toEqual(["Unexpected"]);
  });

  it("handles an empty list", () => {
    expect(groupCommands([], ["Go to"])).toEqual([]);
  });
});
