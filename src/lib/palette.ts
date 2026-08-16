// Ranking for the command palette.
//
// The feedback worth noticing is people who use a TUI and dislike using
// it: they want a GUI's rendering with a terminal's speed. Loupe asked
// them to give up the second to get the first, because every navigation
// needed the mouse.
//
// Scoring is separate from the component for the usual reason — what
// "best match" means is the whole feature, and it is testable without a
// DOM. The bands mirror the context picker's: an exact match beats a
// prefix, a prefix beats a substring, and a subsequence is the last
// resort rather than a peer.

export interface Command {
  /// Stable across renders; used as the React key and for the selection.
  id: string;
  /// Section heading. Ordered by `GROUP_ORDER` rather than by score, so
  /// the palette does not reshuffle its own structure as you type.
  group: string;
  label: string;
  /// Secondary text — the API group, the cluster, the namespace.
  hint?: string;
  /// Extra words that should match without being displayed. "deploy"
  /// finding Deployments is worth having and not worth showing.
  keywords?: string;
  run: () => void;
}

const EXACT = 10_000;
const PREFIX = 8_000;
const SUBSTRING = 6_000;
const HINT = 4_000;
const SUBSEQUENCE = 2_000;

function subsequence(hay: string, needle: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}

function scoreTerm(label: string, rest: string, term: string): number {
  if (label === term) return EXACT;
  if (label.startsWith(term)) return PREFIX - label.length;

  const inLabel = label.indexOf(term);
  if (inLabel >= 0) return SUBSTRING - inLabel;

  if (rest.includes(term)) return HINT;
  if (subsequence(label, term)) return SUBSEQUENCE;
  return 0;
}

/// Ranks commands against a query.
///
/// Every whitespace-separated term must match, so "pod prod" narrows.
/// An empty query returns everything in the order given, which is the
/// order the caller thought sensible.
export function rankCommands(commands: Command[], query: string): Command[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return commands;

  const scored: { command: Command; score: number }[] = [];
  for (const command of commands) {
    const label = command.label.toLowerCase();
    const rest = `${command.hint ?? ""} ${command.keywords ?? ""} ${command.group}`.toLowerCase();

    let total = 0;
    for (const term of terms) {
      const score = scoreTerm(label, rest, term);
      // One unmatched term disqualifies it: the user is narrowing, and a
      // result missing half of what they typed is not narrower.
      if (score === 0) {
        total = 0;
        break;
      }
      total += score;
    }
    if (total > 0) scored.push({ command, score: total });
  }

  scored.sort(
    (a, b) => b.score - a.score || a.command.label.localeCompare(b.command.label),
  );
  return scored.map((s) => s.command);
}

/// Groups ranked commands for display, keeping each group's internal
/// order and putting groups in a fixed sequence.
///
/// Fixed rather than by best-score: a palette whose sections jump around
/// as you type is harder to use than one whose sections stay put, even
/// when the jumping is technically better ranked.
export function groupCommands(
  commands: Command[],
  order: string[],
): { group: string; commands: Command[] }[] {
  const seen = new Map<string, Command[]>();
  for (const command of commands) {
    const bucket = seen.get(command.group);
    if (bucket) bucket.push(command);
    else seen.set(command.group, [command]);
  }

  const out: { group: string; commands: Command[] }[] = [];
  for (const group of order) {
    const found = seen.get(group);
    if (found?.length) out.push({ group, commands: found });
    seen.delete(group);
  }
  // Anything with a group the caller did not order still has to appear.
  for (const [group, found] of seen) {
    if (found.length) out.push({ group, commands: found });
  }
  return out;
}
