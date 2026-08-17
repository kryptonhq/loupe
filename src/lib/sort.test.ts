import { describe, expect, it } from "vitest";
import {
  compareValues,
  nextSort,
  parseDuration,
  parseRatio,
  sortRows,
  type SortValue,
} from "./sort";

/// Sorts a bare list of cell values the way a column would.
function order(values: SortValue[], direction: "asc" | "desc" = "asc") {
  return sortRows(values, (v) => v, direction);
}

describe("nextSort", () => {
  it("starts ascending on a new column", () => {
    expect(nextSort(null, "age")).toEqual({ key: "age", direction: "asc" });
  });

  it("cycles ascending, descending, then off", () => {
    const asc = nextSort(null, "age");
    const desc = nextSort(asc, "age");
    expect(desc).toEqual({ key: "age", direction: "desc" });
    // Off is a real state: the server's own order is what kubectl prints,
    // and getting back to it should not need a reload.
    expect(nextSort(desc, "age")).toBeNull();
  });

  it("starts over when a different column is clicked", () => {
    const desc = { key: "age", direction: "desc" as const };
    expect(nextSort(desc, "name")).toEqual({ key: "name", direction: "asc" });
  });
});

describe("parseDuration", () => {
  it("reads the ages the API server prints", () => {
    expect(parseDuration("30s")).toBe(30);
    expect(parseDuration("5m")).toBe(300);
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("3d")).toBe(259_200);
  });

  it("reads a compound age", () => {
    expect(parseDuration("4h5m")).toBe(4 * 3600 + 5 * 60);
    expect(parseDuration("2y64d")).toBe(2 * 31_536_000 + 64 * 86_400);
  });

  it("refuses anything that is not one", () => {
    expect(parseDuration("Running")).toBeNull();
    expect(parseDuration("1/1")).toBeNull();
    expect(parseDuration("v1.33.1")).toBeNull();
    expect(parseDuration("")).toBeNull();
    // A bare number has no unit, so it is a count and not an age.
    expect(parseDuration("12")).toBeNull();
  });
});

describe("parseRatio", () => {
  it("reads a ready count", () => {
    expect(parseRatio("1/1")).toEqual({ ratio: 1, total: 1 });
    expect(parseRatio("0/3")).toEqual({ ratio: 0, total: 3 });
  });

  it("treats nothing-to-be-ready as ready rather than as NaN", () => {
    expect(parseRatio("0/0")).toEqual({ ratio: 1, total: 0 });
  });

  it("refuses anything that is not one", () => {
    expect(parseRatio("kube-system")).toBeNull();
    expect(parseRatio("1")).toBeNull();
  });
});

describe("sorting ages", () => {
  it("orders by elapsed time rather than alphabetically", () => {
    // The whole reason this file exists: as text, "10m" sorts before
    // "2d", and "65d" before "9h".
    expect(order(["65d", "10m", "2d", "9h", "30s"])).toEqual([
      "30s",
      "10m",
      "9h",
      "2d",
      "65d",
    ]);
  });

  it("reverses cleanly", () => {
    expect(order(["10m", "65d", "9h"], "desc")).toEqual(["65d", "9h", "10m"]);
  });
});

describe("sorting ready counts", () => {
  it("puts the least ready first", () => {
    // What the column is scanned for.
    expect(order(["1/1", "0/1", "2/3", "3/3"])).toEqual([
      "0/1",
      "2/3",
      "1/1",
      "3/3",
    ]);
  });

  it("breaks a tie on the larger set", () => {
    expect(order(["1/1", "5/5"])).toEqual(["1/1", "5/5"]);
  });
});

describe("sorting numbers", () => {
  it("orders restart counts numerically, not as text", () => {
    expect(order([0, 12, 2, 7])).toEqual([0, 2, 7, 12]);
  });

  it("orders numbers that arrive as strings", () => {
    // Server-printed tables send every cell as a string.
    expect(order(["0", "12", "2", "7"])).toEqual(["0", "2", "7", "12"]);
  });
});

describe("sorting names", () => {
  it("orders a generated name the way a person reads it", () => {
    expect(order(["pod-10", "pod-2", "pod-1"])).toEqual([
      "pod-1",
      "pod-2",
      "pod-10",
    ]);
  });

  it("ignores case", () => {
    expect(order(["beta", "Alpha"])).toEqual(["Alpha", "beta"]);
  });
});

describe("missing values", () => {
  it("sinks them, whichever way the sort runs", () => {
    // A column of em dashes at the top is not what anyone wanted from a
    // sort, so absence is not a value that can win.
    expect(order(["3d", "—", "1h"])).toEqual(["1h", "3d", "—"]);
    expect(order(["3d", "—", "1h"], "desc")).toEqual(["3d", "1h", "—"]);
  });

  it("treats the server's several ways of saying nothing alike", () => {
    expect(order(["b", "<none>", "a", null, ""])).toEqual([
      "a",
      "b",
      "<none>",
      null,
      "",
    ]);
  });
});

describe("sortRows", () => {
  it("is stable, so equal rows keep the order the server sent", () => {
    const rows = [
      { name: "c", phase: "Running" },
      { name: "a", phase: "Running" },
      { name: "b", phase: "Pending" },
    ];
    expect(sortRows(rows, (r) => r.phase, "asc").map((r) => r.name)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("leaves the input alone", () => {
    const rows = ["b", "a"];
    sortRows(rows, (r) => r, "asc");
    expect(rows).toEqual(["b", "a"]);
  });
});

describe("compareValues", () => {
  it("is consistent in both directions", () => {
    expect(compareValues("1h", "3d")).toBeLessThan(0);
    expect(compareValues("3d", "1h")).toBeGreaterThan(0);
    expect(compareValues("3d", "3d")).toBe(0);
  });
});
