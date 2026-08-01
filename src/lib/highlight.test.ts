import { describe, expect, it } from "vitest";
import { highlightYaml, opensBlockScalar, tokenizeLine } from "./highlight";

const kinds = (line: string, inBlock = false) =>
  tokenizeLine(line, inBlock)
    .filter((t) => t.text.trim() !== "")
    .map((t) => `${t.kind}:${t.text}`);

describe("tokenizeLine", () => {
  it("splits a key and its scalar value", () => {
    expect(kinds("  name: coredns")).toEqual([
      "key:name",
      "punctuation::",
      "text:coredns",
    ]);
  });

  it("classifies quoted strings, numbers, booleans and nulls", () => {
    expect(kinds('  image: "nginx:1.25"')).toContain('string:"nginx:1.25"');
    expect(kinds("  replicas: 3")).toContain("number:3");
    expect(kinds("  ready: true")).toContain("boolean:true");
    expect(kinds("  reason: null")).toContain("null:null");
  });

  it("does not colour version strings as numbers", () => {
    // "1.2.3" is not a YAML number, and highlighting it as one is a
    // more visible error than leaving it plain.
    expect(kinds("  version: 1.2.3")).toContain("text:1.2.3");
  });

  it("keeps colons inside a value with the value", () => {
    // The key must stop at the FIRST ": ", so an image reference with a
    // tag does not get split down the middle.
    expect(kinds("  image: ghcr.io/kryptonhq/loupe:0.1.0")).toEqual([
      "key:image",
      "punctuation::",
      "text:ghcr.io/kryptonhq/loupe:0.1.0",
    ]);
  });

  // Token text is preserved byte for byte, including the space after a
  // sequence dash — that exactness is what lets the document round-trip.
  it("marks sequence items", () => {
    expect(kinds("  - name: agent")).toEqual([
      "punctuation:- ",
      "key:name",
      "punctuation::",
      "text:agent",
    ]);
  });

  it("handles a bare sequence scalar", () => {
    expect(kinds("    - sre")).toEqual(["punctuation:- ", "text:sre"]);
  });

  it("marks whole-line and trailing comments", () => {
    expect(kinds("# a comment")).toEqual(["comment:# a comment"]);
    expect(kinds("  port: 8080 # the api")).toEqual([
      "key:port",
      "punctuation::",
      "number:8080",
      "comment: # the api",
    ]);
  });

  it("treats block scalar content as opaque text", () => {
    // Inside a block scalar this looks like a mapping but is not one,
    // and the whole line including its indent stays a single token.
    expect(kinds("    not: a mapping # nor a comment", true)).toEqual([
      "text:    not: a mapping # nor a comment",
    ]);
  });

  it("preserves indentation", () => {
    const tokens = tokenizeLine("    name: x", false);
    expect(tokens[0].text).toBe("    ");
  });

  it("handles an empty line", () => {
    expect(tokenizeLine("", false)).toEqual([]);
  });

  it("handles a key with no value", () => {
    expect(kinds("  metadata:")).toEqual(["key:metadata", "punctuation::"]);
  });
});

describe("opensBlockScalar", () => {
  it("recognises the block scalar indicators", () => {
    expect(opensBlockScalar("  script: |")).toBe(true);
    expect(opensBlockScalar("  script: >-")).toBe(true);
    expect(opensBlockScalar("  script: |2")).toBe(true);
    expect(opensBlockScalar("  name: value")).toBe(false);
    // A pipe inside a value is not a block scalar opener.
    expect(opensBlockScalar("  cmd: sh -c 'a | b'")).toBe(false);
  });
});

describe("highlightYaml", () => {
  it("keeps block scalar bodies unparsed until the indent returns", () => {
    const doc = [
      "apiVersion: v1",
      "data:",
      "  config: |",
      "    key: not-a-yaml-key",
      "    # not-a-comment",
      "  next: real",
    ].join("\n");

    const lines = highlightYaml(doc);

    // The two indented body lines are opaque…
    expect(lines[3].tokens.map((t) => t.kind)).toEqual(["text"]);
    expect(lines[4].tokens.map((t) => t.kind)).toEqual(["text"]);
    // …and the block closes when indentation comes back.
    expect(lines[5].tokens.some((t) => t.kind === "key")).toBe(true);
  });

  it("returns one entry per line", () => {
    const doc = "a: 1\nb: 2\nc: 3";
    expect(highlightYaml(doc)).toHaveLength(3);
  });

  it("round-trips the original text", () => {
    // Highlighting must never lose or reorder characters — the YAML tab
    // is something people copy out of.
    const doc = [
      "apiVersion: apps/v1",
      "metadata:",
      "  labels:",
      "    app: demo",
      "  annotations: {}",
      "spec:",
      "  containers:",
      "    - name: agent",
      "      image: ghcr.io/x/y:1.0",
      "      args:",
      "        - --flag=value",
      "  script: |",
      "    echo hello: world",
      "",
      "  done: true",
    ].join("\n");

    const rebuilt = highlightYaml(doc)
      .map((l) => l.tokens.map((t) => t.text).join(""))
      .join("\n");

    expect(rebuilt).toBe(doc);
  });
});
