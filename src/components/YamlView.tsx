import { useMemo, useState } from "react";
import { highlightYaml, type TokenKind } from "../lib/highlight";

// Colours come from the --syn-* tokens so the pane works in both
// themes. Keys carry the structure and get the strongest weight;
// punctuation recedes; comments recede furthest.
const TOKEN_STYLE: Record<TokenKind, string> = {
  key: "text-[rgb(var(--syn-key))]",
  string: "text-[rgb(var(--syn-string))]",
  number: "text-[rgb(var(--syn-number))]",
  boolean: "text-[rgb(var(--syn-const))]",
  null: "text-[rgb(var(--syn-const))]",
  comment: "text-[rgb(var(--syn-comment))] italic",
  punctuation: "text-[rgb(var(--syn-punct))]",
  text: "text-[rgb(var(--code-fg))]",
};

export function YamlView({ source }: { source: string }) {
  const [copied, setCopied] = useState(false);
  const lines = useMemo(() => highlightYaml(source), [source]);

  async function copy() {
    await navigator.clipboard.writeText(source);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="relative h-full bg-[rgb(var(--code-bg))]">
      <button
        onClick={copy}
        className="glass-overlay absolute right-3 top-2 z-10 px-2 py-1 text-2xs text-content-secondary transition-colors duration-150 ease-swift hover:text-content"
      >
        {copied ? "Copied" : "Copy"}
      </button>

      <pre className="h-full overflow-auto py-2 font-mono text-xs leading-[1.6]">
        <code>
          {lines.map((line, i) => (
            <div
              key={i}
              className="flex hover:bg-[rgb(var(--code-line-hover)/0.04)]"
            >
              {/* Line numbers are unselectable so copying the pane
                  yields YAML, not YAML interleaved with digits. */}
              <span className="w-12 shrink-0 select-none pr-3 text-right text-[rgb(var(--code-gutter))]">
                {i + 1}
              </span>
              <span className="min-w-0 whitespace-pre pr-4">
                {line.tokens.length === 0 ? (
                  " "
                ) : (
                  line.tokens.map((t, j) => (
                    <span key={j} className={TOKEN_STYLE[t.kind]}>
                      {t.text}
                    </span>
                  ))
                )}
              </span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}
