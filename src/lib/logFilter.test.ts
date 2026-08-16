import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER,
  compileFilter,
  highlightSegments,
  type FilterSpec,
} from "./logFilter";

function spec(over: Partial<FilterSpec> = {}): FilterSpec {
  return { ...EMPTY_FILTER, ...over };
}

describe("compileFilter", () => {
  it("matches everything when nothing is typed", () => {
    const f = compileFilter(EMPTY_FILTER);
    expect(f.active).toBe(false);
    expect(f.test("anything at all")).toBe(true);
  });

  it("matches a substring without treating it as a pattern", () => {
    // Log lines are full of regex metacharacters. Typing an IP address
    // should find that IP address, not match any character.
    const f = compileFilter(spec({ include: "10.0.0.1" }));
    expect(f.test("connected to 10.0.0.1")).toBe(true);
    expect(f.test("connected to 10x0y0z1")).toBe(false);
  });

  it("ignores case by default and respects it when asked", () => {
    expect(compileFilter(spec({ include: "error" })).test("ERROR: nope")).toBe(true);
    expect(
      compileFilter(spec({ include: "error", caseSensitive: true })).test("ERROR: nope"),
    ).toBe(false);
  });

  it("treats the pattern as a regex when asked", () => {
    const f = compileFilter(spec({ include: "^GET /(health|ready)", regex: true }));
    expect(f.test("GET /health 200")).toBe(true);
    expect(f.test("POST /health 200")).toBe(false);
  });

  it("hides lines matching the exclusion even when they match the include", () => {
    // The `| grep foo | grep -v bar` shape, which is how anyone actually
    // reads a noisy log.
    const f = compileFilter(spec({ include: "request", exclude: "/healthz" }));
    expect(f.test("request GET /api")).toBe(true);
    expect(f.test("request GET /healthz")).toBe(false);
  });

  it("excludes on its own, with no include", () => {
    const f = compileFilter(spec({ exclude: "debug" }));
    expect(f.test("info: started")).toBe(true);
    expect(f.test("debug: noise")).toBe(false);
  });

  it("reports an invalid regex and shows everything rather than nothing", () => {
    // A regex is invalid for most of the time it is being typed. Blanking
    // the view on every keystroke reads as a pod that went silent.
    const f = compileFilter(spec({ include: "GET /(health", regex: true }));
    expect(f.error).not.toBeNull();
    expect(f.test("anything")).toBe(true);
    expect(f.active).toBe(false);
  });

  it("does not carry match state between lines", () => {
    // The compiled pattern is global so it can highlight every match in
    // a line. A stateful `lastIndex` would make every other test lie.
    const f = compileFilter(spec({ include: "x" }));
    expect(f.test("x")).toBe(true);
    expect(f.test("x")).toBe(true);
    expect(f.test("x")).toBe(true);
  });

  it("ignores surrounding whitespace in the pattern", () => {
    expect(compileFilter(spec({ include: "  " })).active).toBe(false);
  });
});

describe("highlightSegments", () => {
  it("returns the line whole when there is nothing to highlight", () => {
    expect(highlightSegments("plain line", null)).toEqual([
      { text: "plain line", match: false },
    ]);
  });

  it("splits a line around each match", () => {
    const { highlight } = compileFilter(spec({ include: "err" }));
    expect(highlightSegments("err and err", highlight)).toEqual([
      { text: "err", match: true },
      { text: " and ", match: false },
      { text: "err", match: true },
    ]);
  });

  it("keeps the text either side of a match", () => {
    const { highlight } = compileFilter(spec({ include: "middle" }));
    expect(highlightSegments("a middle z", highlight)).toEqual([
      { text: "a ", match: false },
      { text: "middle", match: true },
      { text: " z", match: false },
    ]);
  });

  it("reassembles into the original line", () => {
    const { highlight } = compileFilter(spec({ include: "o" }));
    const line = "foo bar boo";
    const joined = highlightSegments(line, highlight)
      .map((s) => s.text)
      .join("");
    expect(joined).toBe(line);
  });

  it("terminates on a pattern that can match nothing", () => {
    // `.*` is an easy thing to type, and a zero-width match without a
    // guard spins forever — a hang, not a wrong answer.
    const { highlight } = compileFilter(spec({ include: ".*", regex: true }));
    const segments = highlightSegments("some line", highlight);
    expect(segments.map((s) => s.text).join("")).toBe("some line");
  });

  it("is case insensitive when the filter is", () => {
    const { highlight } = compileFilter(spec({ include: "error" }));
    expect(highlightSegments("ERROR here", highlight)).toEqual([
      { text: "ERROR", match: true },
      { text: " here", match: false },
    ]);
  });
});
