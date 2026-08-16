import { describe, expect, it } from "vitest";
import { LogBuffer } from "./logBuffer";

// The buffer is what keeps a chatty pod from growing memory without
// bound, and absolute indexing is what keeps a filter's list of matches
// valid while the window slides. Both are easy to get subtly wrong in a
// way that only shows up after thousands of lines, which is exactly when
// nobody is watching.

describe("LogBuffer", () => {
  it("returns lines by their absolute index", () => {
    const buf = new LogBuffer(4);
    expect(buf.push("a")).toBe(0);
    expect(buf.push("b")).toBe(1);

    expect(buf.get(0)).toBe("a");
    expect(buf.get(1)).toBe("b");
    expect(buf.size).toBe(2);
  });

  it("keeps the newest lines when it overflows", () => {
    // The tail is what anyone reading logs wants; dropping from the
    // front is the whole point of the cap.
    const buf = new LogBuffer(3);
    for (const line of ["a", "b", "c", "d", "e"]) buf.push(line);

    expect(buf.toArray()).toEqual(["c", "d", "e"]);
    expect(buf.size).toBe(3);
  });

  it("keeps absolute indices stable across eviction", () => {
    // A filter records which lines matched by absolute index. If those
    // shifted as lines were dropped, every match would quietly point at
    // the wrong line.
    const buf = new LogBuffer(3);
    for (const line of ["a", "b", "c", "d", "e"]) buf.push(line);

    expect(buf.firstIndex).toBe(2);
    expect(buf.nextIndex).toBe(5);
    expect(buf.get(2)).toBe("c");
    expect(buf.get(4)).toBe("e");
  });

  it("reports an evicted line as gone rather than as another line", () => {
    const buf = new LogBuffer(2);
    for (const line of ["a", "b", "c"]) buf.push(line);

    expect(buf.get(0)).toBeUndefined();
    expect(buf.get(99)).toBeUndefined();
  });

  it("counts what it dropped", () => {
    // The viewer says "showing last N" on the strength of this, and
    // saying it when nothing was dropped would be a lie.
    const buf = new LogBuffer(2);
    expect(buf.dropped).toBe(0);
    buf.push("a");
    buf.push("b");
    expect(buf.dropped).toBe(0);
    buf.push("c");
    expect(buf.dropped).toBe(1);
  });

  it("clamps a slice to what it still holds", () => {
    const buf = new LogBuffer(3);
    for (const line of ["a", "b", "c", "d"]) buf.push(line);

    // Asking from before the window and past the end is normal: the
    // viewer asks for a fixed-size window near the end of the buffer.
    expect(buf.slice(0, 100)).toEqual(["b", "c", "d"]);
    expect(buf.slice(2, 3)).toEqual(["c"]);
    expect(buf.slice(10, 20)).toEqual([]);
  });

  it("survives many times its capacity", () => {
    // Wrapping arithmetic that is off by one shows up here and nowhere
    // else — a short test never wraps the ring at all.
    const buf = new LogBuffer(100);
    for (let i = 0; i < 10_000; i += 1) buf.push(`line ${i}`);

    expect(buf.size).toBe(100);
    expect(buf.get(9_999)).toBe("line 9999");
    expect(buf.get(9_900)).toBe("line 9900");
    expect(buf.get(9_899)).toBeUndefined();
    expect(buf.toArray()[0]).toBe("line 9900");
  });

  it("starts over when cleared", () => {
    // Clearing means a different stream. Carrying the dropped count over
    // would make the new view claim it had already lost lines.
    const buf = new LogBuffer(3);
    for (const line of ["a", "b", "c", "d"]) buf.push(line);
    buf.clear();

    expect(buf.size).toBe(0);
    expect(buf.dropped).toBe(0);
    expect(buf.firstIndex).toBe(0);
    expect(buf.push("fresh")).toBe(0);
  });

  it("refuses a capacity that cannot hold anything", () => {
    expect(() => new LogBuffer(0)).toThrow(RangeError);
  });
});
