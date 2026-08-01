import { useMemo, useState } from "react";
import { highlightYaml, type TokenKind } from "../lib/highlight";

// Colours are assigned per token kind. Keys carry the structure, so they
// get the strongest weight; punctuation recedes; comments recede furthest.
const TOKEN_CLASS: Record<TokenKind, string> = {
  key: "text-sky-300",
  string: "text-emerald-300",
  number: "text-amber-300",
  boolean: "text-purple-300",
  null: "text-purple-300",
  comment: "text-slate-500 italic",
  punctuation: "text-slate-500",
  text: "text-slate-200",
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
    <div className="relative h-full">
      <button
        onClick={copy}
        className="absolute right-3 top-2 z-10 rounded border border-slate-700 bg-slate-900/90 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
      >
        {copied ? "Copied" : "Copy"}
      </button>

      <pre className="h-full overflow-auto bg-slate-950 py-2 font-mono text-xs leading-relaxed">
        <code>
          {lines.map((line, i) => (
            <div key={i} className="flex hover:bg-slate-900/60">
              {/* Line numbers are unselectable so copying the pane
                  yields YAML, not YAML interleaved with digits. */}
              <span className="w-12 shrink-0 select-none pr-3 text-right text-slate-600">
                {i + 1}
              </span>
              <span className="min-w-0 whitespace-pre pr-4">
                {line.tokens.length === 0 ? (
                  " "
                ) : (
                  line.tokens.map((t, j) => (
                    <span key={j} className={TOKEN_CLASS[t.kind]}>
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
