import { describe, expect, it } from "vitest";
import { LogBuffer } from "./logBuffer";
import { EMPTY_FILTER, compileFilter, type FilterSpec } from "./logFilter";
import { FilterIndex, filterKey } from "./logView";

function spec(over: Partial<FilterSpec> = {}): FilterSpec {
  return { ...EMPTY_FILTER, ...over };
}

/// Syncs an index against a buffer with the given filter, the way the
/// viewer does on every flush.
function sync(index: FilterIndex, buffer: LogBuffer, s: FilterSpec) {
  const compiled = compileFilter(s);
  index.sync(buffer, compiled, filterKey(s));
  return compiled;
}

function fill(buffer: LogBuffer, lines: string[]) {
  for (const line of lines) buffer.push(line);
}

describe("FilterIndex", () => {
  it("records the lines that match", () => {
    const buf = new LogBuffer(10);
    fill(buf, ["error one", "fine", "error two"]);

    const index = new FilterIndex();
    const filter = sync(index, buf, spec({ include: "error" }));

    expect(index.matchCount).toBe(2);
    expect(index.visible(buf, filter, 0)).toEqual([0, 2]);
  });

  it("says there is nothing to filter when no pattern is set", () => {
    // Null is the signal to walk the buffer directly, which keeps the
    // common path free of any per-line work at all.
    const buf = new LogBuffer(10);
    fill(buf, ["a", "b"]);

    const index = new FilterIndex();
    const filter = sync(index, buf, EMPTY_FILTER);

    expect(index.visible(buf, filter, 0)).toBeNull();
  });

  it("tests each line once as more arrive", () => {
    // The incremental path. A line already tested must not be tested
    // again on the next flush, which is the whole reason this exists.
    const buf = new LogBuffer(10);
    const index = new FilterIndex();
    const s = spec({ include: "hit" });

    fill(buf, ["hit one", "miss"]);
    sync(index, buf, s);
    expect(index.matchCount).toBe(1);

    fill(buf, ["miss", "hit two"]);
    const filter = sync(index, buf, s);

    expect(index.visible(buf, filter, 0)).toEqual([0, 3]);
  });

  it("rescans from scratch when the filter changes", () => {
    const buf = new LogBuffer(10);
    fill(buf, ["alpha", "beta", "alpha"]);

    const index = new FilterIndex();
    sync(index, buf, spec({ include: "alpha" }));
    expect(index.matchCount).toBe(2);

    const filter = sync(index, buf, spec({ include: "beta" }));
    expect(index.visible(buf, filter, 0)).toEqual([1]);
  });

  it("drops matches for lines the buffer has evicted", () => {
    // A match pointing past the start of the ring would render as a
    // blank row, or as whatever line happens to sit there now.
    const buf = new LogBuffer(3);
    const index = new FilterIndex();
    const s = spec({ include: "keep" });

    fill(buf, ["keep 0", "keep 1"]);
    sync(index, buf, s);
    expect(index.matchCount).toBe(2);

    fill(buf, ["x", "x", "keep 4"]);
    const filter = sync(index, buf, s);

    // Only "keep 4" is still retained; the two early matches are gone.
    expect(index.visible(buf, filter, 0)).toEqual([4]);
  });

  it("recovers when the buffer restarts under it", () => {
    // Switching container clears the buffer, so absolute indices start
    // again. An index still scanning from the old high-water mark would
    // silently never match anything again.
    const buf = new LogBuffer(10);
    const index = new FilterIndex();
    const s = spec({ include: "hit" });

    fill(buf, ["hit a", "hit b", "hit c"]);
    sync(index, buf, s);
    expect(index.matchCount).toBe(3);

    buf.clear();
    fill(buf, ["hit d"]);
    const filter = sync(index, buf, s);

    expect(index.visible(buf, filter, 0)).toEqual([0]);
  });

  it("includes surrounding lines when context is asked for", () => {
    const buf = new LogBuffer(10);
    fill(buf, ["0", "1", "hit", "3", "4"]);

    const index = new FilterIndex();
    const filter = sync(index, buf, spec({ include: "hit" }));

    expect(index.visible(buf, filter, 1)).toEqual([1, 2, 3]);
  });

  it("does not repeat lines where two matches' context overlaps", () => {
    // Overlapping windows are the normal case in a burst of errors, and
    // a repeated absolute index would render the same line twice.
    const buf = new LogBuffer(10);
    fill(buf, ["0", "hit", "2", "hit", "4"]);

    const index = new FilterIndex();
    const filter = sync(index, buf, spec({ include: "hit" }));

    expect(index.visible(buf, filter, 1)).toEqual([0, 1, 2, 3, 4]);
  });

  it("keeps context inside what the buffer still holds", () => {
    const buf = new LogBuffer(3);
    fill(buf, ["a", "b", "c", "hit"]);

    const index = new FilterIndex();
    const filter = sync(index, buf, spec({ include: "hit" }));

    // Asking for five lines of context around the last line must not
    // produce indices for evicted lines or for lines not yet received.
    for (const i of index.visible(buf, filter, 5) ?? []) {
      expect(buf.get(i)).toBeDefined();
    }
  });

  it("shows everything when the pattern does not compile", () => {
    // compileFilter reports the error and matches everything; the index
    // has to agree, or a half-typed regex blanks the view.
    const buf = new LogBuffer(10);
    fill(buf, ["a", "b"]);

    const index = new FilterIndex();
    const filter = sync(index, buf, spec({ include: "(unclosed", regex: true }));

    expect(filter.error).not.toBeNull();
    expect(index.visible(buf, filter, 0)).toBeNull();
  });

  it("forgets everything when reset", () => {
    const buf = new LogBuffer(10);
    fill(buf, ["hit"]);

    const index = new FilterIndex();
    sync(index, buf, spec({ include: "hit" }));
    index.reset();

    expect(index.matchCount).toBe(0);
  });
});

describe("filterKey", () => {
  it("distinguishes filters that ask different questions", () => {
    expect(filterKey(spec({ include: "a" }))).not.toBe(filterKey(spec({ include: "b" })));
    expect(filterKey(spec({ include: "a" }))).not.toBe(
      filterKey(spec({ include: "a", regex: true })),
    );
    expect(filterKey(spec({ include: "a" }))).not.toBe(
      filterKey(spec({ include: "a", caseSensitive: true })),
    );
    expect(filterKey(spec({ exclude: "a" }))).not.toBe(filterKey(spec({ include: "a" })));
  });

  it("treats a pattern the same however it is spaced", () => {
    // The filter itself trims, so the key must too — otherwise typing a
    // trailing space forces a pointless full rescan.
    expect(filterKey(spec({ include: " a " }))).toBe(filterKey(spec({ include: "a" })));
  });
});
