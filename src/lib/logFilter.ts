// Compiling the log filter box into something that can test a line.
//
// Kept separate from the viewer because the interesting behaviour is
// textual, not visual: what counts as a match, what an invalid regex
// does, and how a match is located well enough to highlight rather than
// merely hide the lines around it.

export interface FilterSpec {
  /// Lines must match this to be shown. Empty means "everything".
  include: string;
  /// Lines matching this are hidden, even when they match `include` —
  /// the equivalent of piping through `grep -v`.
  exclude: string;
  /// Treat both patterns as regular expressions rather than substrings.
  regex: boolean;
  caseSensitive: boolean;
}

export const EMPTY_FILTER: FilterSpec = {
  include: "",
  exclude: "",
  regex: false,
  caseSensitive: false,
};

export interface CompiledFilter {
  /// True when the line should be shown.
  test: (line: string) => boolean;
  /// Locates the part of a line to highlight, or null when there is
  /// nothing to highlight (no include pattern, or it did not compile).
  highlight: RegExp | null;
  /// Set when a pattern could not be compiled. The filter then matches
  /// everything rather than nothing: a half-typed regex should not
  /// blank the screen and imply the pod went quiet.
  error: string | null;
  /// False when nothing is being filtered, so callers can skip the work
  /// entirely on the common path.
  active: boolean;
}

/// Escapes a string so it matches itself when used as a regex.
function escape(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function build(pattern: string, spec: FilterSpec): RegExp {
  const source = spec.regex ? pattern : escape(pattern);
  return new RegExp(source, spec.caseSensitive ? "g" : "gi");
}

/// Turns the filter box into a predicate.
///
/// An invalid regex is reported rather than thrown: the user is midway
/// through typing one for most of its life, and a viewer that throws on
/// every keystroke is unusable.
export function compileFilter(spec: FilterSpec): CompiledFilter {
  const include = spec.include.trim();
  const exclude = spec.exclude.trim();

  if (!include && !exclude) {
    return { test: () => true, highlight: null, error: null, active: false };
  }

  let includeRe: RegExp | null = null;
  let excludeRe: RegExp | null = null;
  let error: string | null = null;

  try {
    if (include) includeRe = build(include, spec);
  } catch (e) {
    error = e instanceof Error ? e.message : "invalid pattern";
    includeRe = null;
  }

  if (!error) {
    try {
      if (exclude) excludeRe = build(exclude, spec);
    } catch (e) {
      error = e instanceof Error ? e.message : "invalid pattern";
      excludeRe = null;
    }
  }

  // A pattern that did not compile filters nothing. Showing every line
  // is a visibly harmless failure; showing none looks like a dead pod.
  if (error) {
    return { test: () => true, highlight: null, error, active: false };
  }

  const test = (line: string) => {
    // Regexes carry `g` for highlighting, which makes `test` stateful.
    // Reset before each use or every other call lies.
    if (includeRe) {
      includeRe.lastIndex = 0;
      if (!includeRe.test(line)) return false;
    }
    if (excludeRe) {
      excludeRe.lastIndex = 0;
      if (excludeRe.test(line)) return false;
    }
    return true;
  };

  return {
    test,
    highlight: includeRe,
    error: null,
    active: Boolean(includeRe || excludeRe),
  };
}

/// Splits a line into alternating plain and matched runs, so the viewer
/// can mark matches in place instead of only hiding what did not match.
///
/// Returns a single plain segment when there is nothing to highlight,
/// which is the common case and costs one allocation.
export function highlightSegments(
  line: string,
  pattern: RegExp | null,
): { text: string; match: boolean }[] {
  if (!pattern) return [{ text: line, match: false }];

  const out: { text: string; match: boolean }[] = [];
  pattern.lastIndex = 0;
  let last = 0;

  for (;;) {
    const found = pattern.exec(line);
    if (!found) break;
    // A pattern able to match the empty string would otherwise spin here
    // forever, and `.*` is an easy thing for a user to type.
    if (found[0] === "") {
      pattern.lastIndex += 1;
      continue;
    }
    if (found.index > last) {
      out.push({ text: line.slice(last, found.index), match: false });
    }
    out.push({ text: found[0], match: true });
    last = found.index + found[0].length;
  }

  if (last < line.length) out.push({ text: line.slice(last), match: false });
  return out.length ? out : [{ text: line, match: false }];
}
