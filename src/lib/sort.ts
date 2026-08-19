// Sorting a listing, in the units the listing is actually in.
//
// A string sort is wrong for almost every column a Kubernetes table has.
// "10m" sorts before "2d" and "65d" before "9h"; "1/1" and "0/3" compare
// as text; "pod-10" lands before "pod-2". A sort that is quietly wrong is
// worse than no sort at all, because the answer looks ordered — so the
// comparator understands what it is looking at rather than falling back
// to lexical order and hoping.
//
// Everything here is pure, and works on values the columns hand over
// rather than on the rendered cell: a cell is a React node, and sorting
// by markup would sort by whatever the renderer happened to emit.

export type SortDirection = "asc" | "desc";

export interface SortState {
  /// The `key` of the column being sorted on.
  key: string;
  direction: SortDirection;
}

/// What a column can be sorted by.
export type SortValue = string | number | null | undefined;

/// Clicking a header cycles ascending, descending, then off.
///
/// Off is a real state rather than a third click that does nothing: the
/// server's own order is meaningful — it is what `kubectl get` prints —
/// so getting back to it should not require reloading the view.
export function nextSort(current: SortState | null, key: string): SortState | null {
  if (current?.key !== key) return { key, direction: "asc" };
  if (current.direction === "asc") return { key, direction: "desc" };
  return null;
}

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  y: 31_536_000,
};

/// Seconds in a Kubernetes age, or null if this is not one.
///
/// Matches what the API server prints: a run of number-unit pairs, most
/// significant first — "65d", "4h5m", "2y64d", "1m2s".
export function parseDuration(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed || !/^(\d+[smhdy])+$/.test(trimmed)) return null;

  let seconds = 0;
  for (const [, amount, unit] of trimmed.matchAll(/(\d+)([smhdy])/g)) {
    seconds += Number(amount) * UNIT_SECONDS[unit];
  }
  return seconds;
}

/// A ready count — "1/1", "0/3" — as the fraction ready and the total.
export function parseRatio(text: string): { ratio: number; total: number } | null {
  const match = /^(\d+)\/(\d+)$/.exec(text.trim());
  if (!match) return null;
  const ready = Number(match[1]);
  const total = Number(match[2]);
  // Nothing to be ready counts as fully ready, rather than as NaN.
  return { ratio: total === 0 ? 1 : ready / total, total };
}

/// Values that mean "the server did not say". They sort to the bottom
/// whichever direction is asked for — a column of em dashes at the top
/// is not what anyone wanted from a sort.
const ABSENT = new Set(["", "—", "-", "<none>", "<unset>", "n/a"]);

function isAbsent(value: SortValue): boolean {
  if (value == null) return true;
  return typeof value === "string" && ABSENT.has(value.trim().toLowerCase());
}

/// Order two cell values, understanding numbers, ages and ready counts
/// before falling back to a natural string comparison.
export function compareValues(a: SortValue, b: SortValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;

  const left = String(a);
  const right = String(b);

  const leftAge = parseDuration(left);
  const rightAge = parseDuration(right);
  if (leftAge !== null && rightAge !== null) return leftAge - rightAge;

  const leftRatio = parseRatio(left);
  const rightRatio = parseRatio(right);
  if (leftRatio && rightRatio) {
    return leftRatio.ratio - rightRatio.ratio || leftRatio.total - rightRatio.total;
  }

  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (left !== "" && right !== "" && !isNaN(leftNumber) && !isNaN(rightNumber)) {
    return leftNumber - rightNumber;
  }

  // `numeric` so pod-2 comes before pod-10, which is the whole reason a
  // generated name is readable at all.
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/// A copy of `rows` in the order asked for.
///
/// Stable, so rows the comparator considers equal keep the order the
/// server sent them in — sorting by status should not shuffle the pods
/// within each status on every render.
export function sortRows<T>(
  rows: T[],
  sortValue: (row: T) => SortValue,
  direction: SortDirection,
): T[] {
  const sign = direction === "asc" ? 1 : -1;

  return rows
    .map((row, index) => ({ row, index, value: sortValue(row) }))
    .sort((a, b) => {
      // Absent values sink regardless of direction, so reversing the
      // sort does not fill the top of the table with nothing.
      const aAbsent = isAbsent(a.value);
      const bAbsent = isAbsent(b.value);
      if (aAbsent !== bAbsent) return aAbsent ? 1 : -1;
      if (aAbsent && bAbsent) return a.index - b.index;

      return compareValues(a.value, b.value) * sign || a.index - b.index;
    })
    .map((entry) => entry.row);
}
