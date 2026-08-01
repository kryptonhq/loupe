// A small YAML tokenizer for the manifest viewer.
//
// Deliberately not a general YAML parser and not a syntax-highlighting
// library. The input is always serde_yaml's output for a Kubernetes
// object, which is a narrow and very regular subset: block mappings,
// block sequences, scalars, and no anchors, tags, or flow collections.
// A hundred lines here avoids a dependency, keeps the bundle small, and
// sidesteps the CSP work that a library injecting <style> would need.
//
// Tokenising is line-based because YAML is line-oriented; the only
// multi-line construct we must survive is a block scalar (| or >),
// whose body must not be parsed as YAML.

export type TokenKind =
  | "comment"
  | "key"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "punctuation"
  | "text";

export interface Token {
  kind: TokenKind;
  text: string;
}

const BOOLEANS = new Set(["true", "false"]);
const NULLS = new Set(["null", "~"]);

/// Classifies a scalar value on the right-hand side of a key.
function scalarKind(value: string): TokenKind {
  if (value === "") return "text";
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return "string";
  }
  if (BOOLEANS.has(value)) return "boolean";
  if (NULLS.has(value)) return "null";
  // Deliberately strict: "1.2.3" and "2024-01-01" are not numbers, and
  // colouring a version string as one is worse than leaving it plain.
  if (/^-?\d+(\.\d+)?$/.test(value)) return "number";
  return "text";
}

/// Splits one line into tokens.
///
/// `inBlockScalar` suppresses all parsing: inside a `|` or `>` block the
/// content is opaque text that may well contain colons and hashes.
export function tokenizeLine(line: string, inBlockScalar: boolean): Token[] {
  if (inBlockScalar) {
    return [{ kind: "text", text: line }];
  }

  const indentMatch = /^(\s*)/.exec(line);
  const indent = indentMatch ? indentMatch[1] : "";
  let rest = line.slice(indent.length);

  const tokens: Token[] = [];
  if (indent) tokens.push({ kind: "text", text: indent });

  if (rest === "") return tokens;

  // A whole-line comment.
  if (rest.startsWith("#")) {
    tokens.push({ kind: "comment", text: rest });
    return tokens;
  }

  // Sequence item marker; the remainder may itself be "key: value".
  if (rest.startsWith("- ") || rest === "-") {
    const marker = rest === "-" ? "-" : "- ";
    tokens.push({ kind: "punctuation", text: marker });
    rest = rest.slice(marker.length);
    if (rest === "") return tokens;
  }

  // "key: value" — the key runs to the first ": " (or a trailing ":").
  const keyMatch = /^([^:\s][^:]*?):(\s|$)/.exec(rest);
  if (keyMatch) {
    const key = keyMatch[1];
    tokens.push({ kind: "key", text: key });
    tokens.push({ kind: "punctuation", text: ":" });

    const after = rest.slice(key.length + 1);
    if (after === "") return tokens;

    const valueIndent = /^(\s*)/.exec(after)?.[1] ?? "";
    if (valueIndent) tokens.push({ kind: "text", text: valueIndent });

    const value = after.slice(valueIndent.length);
    if (value === "") return tokens;

    // A trailing comment after a value.
    const commentAt = value.indexOf(" #");
    if (commentAt >= 0) {
      const scalar = value.slice(0, commentAt);
      tokens.push({ kind: scalarKind(scalar), text: scalar });
      tokens.push({ kind: "comment", text: value.slice(commentAt) });
      return tokens;
    }

    tokens.push({ kind: scalarKind(value), text: value });
    return tokens;
  }

  // A bare scalar: a sequence element, or a continuation line.
  tokens.push({ kind: scalarKind(rest), text: rest });
  return tokens;
}

/// True when this line opens a block scalar, e.g. `key: |` or `key: >-`.
export function opensBlockScalar(line: string): boolean {
  return /:\s*[|>][+-]?\d*\s*$/.test(line);
}

export interface HighlightedLine {
  tokens: Token[];
}

/// Tokenises a whole document, tracking block-scalar regions.
///
/// A block scalar ends when indentation returns to at or below the
/// indentation of the line that opened it.
export function highlightYaml(source: string): HighlightedLine[] {
  const lines = source.split("\n");
  const out: HighlightedLine[] = [];

  let blockIndent: number | null = null;

  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const blank = line.trim() === "";

    if (blockIndent !== null) {
      // Blank lines belong to the block; a non-blank line at or left of
      // the opening indent closes it.
      if (blank || indent > blockIndent) {
        out.push({ tokens: tokenizeLine(line, true) });
        continue;
      }
      blockIndent = null;
    }

    out.push({ tokens: tokenizeLine(line, false) });

    if (!blank && opensBlockScalar(line)) {
      blockIndent = indent;
    }
  }

  return out;
}
