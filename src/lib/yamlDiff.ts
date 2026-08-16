// What an edit is actually about to change.
//
// The YAML tab writes back a full replace. The conflict handling is
// good — an object someone else changed underneath you is rejected
// rather than silently overwritten — but the user never saw what they
// were about to send. They saw the editor they had been typing in,
// pressed Apply, and found out afterwards. On a long manifest with a
// one-field edit there was no way to confirm that only that field moved.
//
// `kubectl diff` exists for the same reason. In a GUI it is cheaper to
// provide and easier to read: hunks only, with the fields that carry
// real weight marked.

/// Fields the server owns. They differ on every fetch and mean nothing
/// as a user change — showing them would bury the one line that matters
/// under noise the user cannot act on.
const SERVER_METADATA = new Set([
  "resourceVersion",
  "uid",
  "generation",
  "creationTimestamp",
  "selfLink",
  "managedFields",
]);

/// Top-level blocks the server owns outright.
const SERVER_BLOCKS = new Set(["status"]);

/// Indentation of a line, or null for blank lines and comments, which
/// belong to whatever block they sit in.
function indentOf(line: string): number | null {
  if (line.trim() === "" || line.trimStart().startsWith("#")) return null;
  return line.length - line.trimStart().length;
}

/// The key a line introduces, if it introduces one.
function keyOf(line: string): string | null {
  const match = /^\s*([A-Za-z0-9_.\-/]+):/.exec(line);
  return match ? match[1] : null;
}

/// Drops everything the server manages, so a diff shows only what the
/// user changed.
///
/// Works on the text rather than on a parsed document deliberately: the
/// diff is shown against the YAML the user is looking at, and
/// round-tripping through a parser would reformat lines they never
/// touched into changes they did not make.
export function stripServerFields(yaml: string): string[] {
  const lines = yaml.split("\n");
  const out: string[] = [];

  // Set while inside a block being dropped; cleared when a line appears
  // at or above the indent the block started at.
  let dropping: number | null = null;
  let inMetadata = false;

  for (const line of lines) {
    const indent = indentOf(line);

    if (dropping !== null) {
      // Blank lines and comments inside a dropped block go with it.
      // So do sequence items: YAML lets `- item` sit at the same indent
      // as the key it belongs to, so indentation alone does not say the
      // block has ended.
      const sequenceItem = indent === dropping && line.trimStart().startsWith("- ");
      if (indent === null || indent > dropping || sequenceItem) continue;
      dropping = null;
    }

    if (indent === 0) inMetadata = keyOf(line) === "metadata";

    if (indent === 0 && SERVER_BLOCKS.has(keyOf(line) ?? "")) {
      dropping = 0;
      continue;
    }

    if (inMetadata && indent !== null && indent > 0) {
      const key = keyOf(line);
      // Only direct children of metadata; a `uid:` nested three levels
      // deep in an annotation is the user's own data.
      if (key && indent === 2 && SERVER_METADATA.has(key)) {
        dropping = indent;
        continue;
      }
    }

    out.push(line);
  }

  // A trailing blank line is an artefact of the split, not a change.
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out;
}

/// Field names whose change is worth more than a whitespace change.
///
/// A one-character image tag edit and a re-indent are the same size in a
/// diff and emphatically not the same size in consequence.
const WEIGHTY = /^\s*(replicas|image|imagePullPolicy|command|args|cpu|memory|limits|requests|selector|matchLabels|serviceAccountName|nodeSelector|hostNetwork|privileged|storageClassName|type|port|targetPort)\s*:/;

export type DiffKind = "added" | "removed" | "context";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /// Line number in the original (for removed and context) or the edited
  /// document (for added), 1-based.
  line: number;
  /// True when the line touches a field whose change carries weight.
  weighty: boolean;
}

export interface Hunk {
  /// 1-based start line in the original document.
  from: number;
  lines: DiffLine[];
}

export interface Diff {
  hunks: Hunk[];
  added: number;
  removed: number;
  /// True when the documents differ only in ways that were stripped —
  /// the user pressed Apply having changed nothing that will be sent.
  empty: boolean;
}

/// Longest common subsequence of two line arrays, as a list of pairs.
///
/// Common prefix and suffix are trimmed first, which is what keeps this
/// affordable: a one-field edit to a 400-line manifest reduces to a
/// handful of lines before the quadratic part runs at all.
function commonLines(a: string[], b: string[]): boolean[][] {
  const n = a.length;
  const m = b.length;
  // Guard against a pathological pair — a wholesale rewrite of a very
  // large manifest. Falling back to "everything changed" is a worse
  // diff, not a wrong one, and it is better than a frozen window.
  if (n * m > 4_000_000) return [];

  const table: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const keepA = Array.from({ length: n }, () => false);
  const keepB = Array.from({ length: m }, () => false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      keepA[i] = true;
      keepB[j] = true;
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return [keepA, keepB];
}

/// Lines of unchanged text kept either side of a change.
const CONTEXT = 3;

/// Diffs two YAML documents, ignoring what the server manages.
export function diffYaml(original: string, edited: string, context = CONTEXT): Diff {
  const a = stripServerFields(original);
  const b = stripServerFields(edited);

  // Trim the identical head and tail before doing any real work.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const [keepA, keepB] = commonLines(midA, midB);

  // Walk the middle, producing a flat list of changes with their line
  // numbers in each document.
  type Entry = { kind: DiffKind; text: string; aIndex: number; bIndex: number };
  const entries: Entry[] = [];
  let i = 0;
  let j = 0;
  while (i < midA.length || j < midB.length) {
    const sameA = keepA ? keepA[i] : false;
    const sameB = keepB ? keepB[j] : false;
    if (i < midA.length && j < midB.length && sameA && sameB) {
      entries.push({ kind: "context", text: midA[i], aIndex: i, bIndex: j });
      i += 1;
      j += 1;
    } else if (i < midA.length && !sameA) {
      entries.push({ kind: "removed", text: midA[i], aIndex: i, bIndex: j });
      i += 1;
    } else if (j < midB.length && !sameB) {
      entries.push({ kind: "added", text: midB[j], aIndex: i, bIndex: j });
      j += 1;
    } else if (i < midA.length) {
      entries.push({ kind: "removed", text: midA[i], aIndex: i, bIndex: j });
      i += 1;
    } else {
      entries.push({ kind: "added", text: midB[j], aIndex: i, bIndex: j });
      j += 1;
    }
  }

  const added = entries.filter((e) => e.kind === "added").length;
  const removed = entries.filter((e) => e.kind === "removed").length;
  if (added === 0 && removed === 0) {
    return { hunks: [], added: 0, removed: 0, empty: true };
  }

  // Keep only changes and the `context` lines either side of them, then
  // group runs into hunks.
  const keep = new Set<number>();
  entries.forEach((entry, index) => {
    if (entry.kind === "context") return;
    for (let k = index - context; k <= index + context; k += 1) {
      if (k >= 0 && k < entries.length) keep.add(k);
    }
  });

  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let previous = -2;

  for (const index of [...keep].sort((x, y) => x - y)) {
    const entry = entries[index];
    if (index !== previous + 1 || current === null) {
      current = { from: head + entry.aIndex + 1, lines: [] };
      hunks.push(current);
    }
    current.lines.push({
      kind: entry.kind,
      text: entry.text,
      line: head + (entry.kind === "added" ? entry.bIndex : entry.aIndex) + 1,
      weighty: WEIGHTY.test(entry.text),
    });
    previous = index;
  }

  return { hunks, added, removed, empty: false };
}
