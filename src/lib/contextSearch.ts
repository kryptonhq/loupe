// Finding one cluster among thousands.
//
// A kubeconfig with several thousand contexts is ordinary in a large
// org — one entry per cluster, written by tooling. The old picker built
// a search string per context per keystroke and filtered on substring,
// which is both slow at that size and bad at the job: on 6,000 contexts
// the one you want is somewhere in an alphabetical list, and typing
// "prod" returns four hundred of them.
//
// So: build each context's haystack once, and *rank* rather than merely
// filter. Ranking is what makes a long list usable — the exact match you
// typed should be first, not thirty-first.

export interface SearchableContext {
  name: string;
  cluster: string;
  namespace: string | null;
}

/// A context with its search text precomputed.
///
/// Built once per kubeconfig rather than per keystroke, which is the
/// difference between 6,000 string builds per character and none.
export interface IndexedContext<T extends SearchableContext> {
  context: T;
  name: string;
  /// Everything searchable, lowercased and joined.
  haystack: string;
}

export function indexContexts<T extends SearchableContext>(
  contexts: T[],
): IndexedContext<T>[] {
  return contexts.map((context) => ({
    context,
    name: context.name.toLowerCase(),
    haystack: `${context.name} ${context.cluster} ${context.namespace ?? ""}`.toLowerCase(),
  }));
}

// Score bands. Spaced far enough apart that a better *kind* of match
// always beats a better position within a worse kind.
const EXACT = 10_000;
const NAME_PREFIX = 8_000;
const NAME_SUBSTRING = 6_000;
const HAYSTACK_SUBSTRING = 4_000;
const SUBSEQUENCE = 2_000;

/// True when every character of `needle` appears in `hay`, in order.
///
/// The fuzzy fallback: "gkeprd" should still find
/// "gke-europe-west1-production". Deliberately last, because on its own
/// it matches far too much to be a primary ranking.
function subsequence(hay: string, needle: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}

/// How well one context matches one term. Zero means it does not.
function scoreTerm(entry: IndexedContext<SearchableContext>, term: string): number {
  if (entry.name === term) return EXACT;
  if (entry.name.startsWith(term)) return NAME_PREFIX - entry.name.length;

  const inName = entry.name.indexOf(term);
  if (inName >= 0) return NAME_SUBSTRING - inName;

  const inHaystack = entry.haystack.indexOf(term);
  if (inHaystack >= 0) return HAYSTACK_SUBSTRING - inHaystack;

  if (subsequence(entry.haystack, term)) return SUBSEQUENCE;
  return 0;
}

export interface Ranked<T extends SearchableContext> {
  context: T;
  score: number;
}

/// Ranks contexts against a query.
///
/// Every whitespace-separated term must match somewhere, so "prod eu"
/// narrows rather than widening as an OR would. An empty query returns
/// everything in the order given, which is the kubeconfig's own order.
export function rankContexts<T extends SearchableContext>(
  indexed: IndexedContext<T>[],
  query: string,
): Ranked<T>[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return indexed.map((entry) => ({ context: entry.context, score: 0 }));
  }

  const out: Ranked<T>[] = [];
  for (const entry of indexed) {
    let total = 0;
    for (const term of terms) {
      const score = scoreTerm(entry, term);
      // One unmatched term disqualifies the context: the user is
      // narrowing, and a result missing half of what they typed is not
      // a narrower answer.
      if (score === 0) {
        total = 0;
        break;
      }
      total += score;
    }
    if (total > 0) out.push({ context: entry.context, score: total });
  }

  // Ties broken by name so the order is stable rather than incidental.
  out.sort((a, b) => b.score - a.score || a.context.name.localeCompare(b.context.name));
  return out;
}

/// Splits contexts into the ones worth showing first and the rest.
///
/// On a 6,000-context kubeconfig, four entries are the ones anyone
/// actually opens. Pinned first, then recently used in the order they
/// were used, then everything else as ranked.
export function partitionContexts<T extends SearchableContext>(
  ranked: Ranked<T>[],
  pinned: string[],
  recent: string[],
): { pinned: T[]; recent: T[]; rest: T[] } {
  const pinnedSet = new Set(pinned);
  const recentOrder = new Map(recent.map((name, i) => [name, i]));

  const inPinned: T[] = [];
  const inRecent: T[] = [];
  const rest: T[] = [];

  for (const { context } of ranked) {
    if (pinnedSet.has(context.name)) inPinned.push(context);
    else if (recentOrder.has(context.name)) inRecent.push(context);
    else rest.push(context);
  }

  // Pinned keeps the user's own order; recents keep use order. Both
  // override relevance, because both are explicit signals about which
  // cluster matters and a fuzzy score is not.
  inPinned.sort((a, b) => pinned.indexOf(a.name) - pinned.indexOf(b.name));
  inRecent.sort(
    (a, b) => (recentOrder.get(a.name) ?? 0) - (recentOrder.get(b.name) ?? 0),
  );

  return { pinned: inPinned, recent: inRecent, rest };
}
