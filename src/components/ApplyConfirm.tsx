import { useMemo, useState } from "react";
import { diffYaml, type DiffLine } from "../lib/yamlDiff";
import type { EditTarget, Guard } from "../lib/api";

// The step between pressing Apply and the request leaving the machine.
//
// It exists because a full replace was previously sent on the strength
// of a button press: the user saw the editor they had been typing in,
// and found out what changed afterwards. On a long manifest with a
// one-field edit there was no way to confirm that only that field moved.
//
// It doubles as where protection lands. On a context marked protected,
// "show me exactly what changes" and "prove you meant this cluster" are
// the same moment, so they are the same panel rather than two dialogs
// stacked on each other.

interface ApplyConfirmProps {
  target: EditTarget;
  original: string;
  edited: string;
  /// The connected context. Named in the heading, and typed back by the
  /// user when the context is protected.
  context: string;
  guard: Guard;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}

export function ApplyConfirm({
  target,
  original,
  edited,
  context,
  guard,
  onConfirm,
  onCancel,
  busy,
}: ApplyConfirmProps) {
  const [typed, setTyped] = useState("");
  const diff = useMemo(() => diffYaml(original, edited), [original, edited]);

  // Trimmed, because a trailing space from a paste is not a
  // disagreement about which cluster this is.
  const confirmed = guard !== "protected" || typed.trim() === context;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[rgb(var(--code-bg))]">
      <div className="border-b px-3 py-2">
        <p className="text-xs font-medium">
          Apply to {target.kind} {target.name}
        </p>
        <p className="mt-0.5 text-2xs text-content-muted">
          {/* The cluster matters more than the object name, which is why
              it is here rather than only in the sidebar. */}
          on <span className="font-medium text-content-secondary">{context}</span>
          {diff.empty
            ? " · nothing to send"
            : ` · +${diff.added} −${diff.removed}`}
        </p>
      </div>

      {diff.empty ? (
        <p className="px-4 py-6 text-center text-xs text-content-muted">
          Nothing would change. The only differences are fields the server
          manages.
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto font-mono text-xs">
          {diff.hunks.map((hunk, h) => (
            <div key={hunk.from} className={h > 0 ? "border-t border-hairline/[0.08]" : ""}>
              <p className="bg-content/[0.04] px-3 py-0.5 text-2xs text-content-muted">
                line {hunk.from}
              </p>
              {hunk.lines.map((line, i) => (
                <DiffRow key={`${hunk.from}-${i}`} line={line} />
              ))}
            </div>
          ))}
        </div>
      )}

      {guard === "protected" && !diff.empty && (
        <div className="border-t border-warn/20 bg-warn/[0.06] px-3 py-2">
          <label className="block text-2xs text-content-secondary">
            {/* Typing the name is the point: it is deliberately not a
                checkbox, because a checkbox can be clicked by reflex. */}
            This context is protected. Type{" "}
            <span className="font-mono font-medium text-content">{context}</span>{" "}
            to confirm.
          </label>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label="Type the context name to confirm"
            autoComplete="off"
            spellCheck={false}
            className="mt-1.5 w-full rounded-sm border bg-content/[0.03] px-2 py-1 font-mono text-xs transition-colors duration-150 ease-swift focus:border-accent/40"
          />
        </div>
      )}

      <div className="flex items-center justify-end gap-1.5 border-t px-3 py-1.5">
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded-sm border px-2 py-1 text-2xs text-content-secondary transition-colors duration-150 ease-swift hover:bg-content/[0.06] hover:text-content disabled:opacity-40"
        >
          Back
        </button>
        <button
          onClick={onConfirm}
          disabled={busy || !confirmed || diff.empty}
          className="rounded-sm bg-accent/[0.18] px-2 py-1 text-2xs font-medium text-accent transition-colors duration-150 ease-swift hover:bg-accent/[0.26] disabled:opacity-40 disabled:hover:bg-accent/[0.18]"
        >
          {busy ? "Applying…" : "Apply"}
        </button>
      </div>
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  const tone =
    line.kind === "added"
      ? "bg-success/[0.10] text-success"
      : line.kind === "removed"
        ? "bg-danger/[0.10] text-danger"
        : "text-content-muted";

  return (
    <div className={`flex ${tone}`}>
      <span className="w-10 shrink-0 select-none px-2 text-right text-2xs tabular-nums opacity-60">
        {line.line}
      </span>
      <span className="w-4 shrink-0 select-none text-center">
        {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
      </span>
      {/* A one-character image tag change and a re-indent are the same
          size in a diff and not the same size in consequence. */}
      <span className={`min-w-0 flex-1 whitespace-pre pr-3 ${line.weighty ? "font-semibold" : ""}`}>
        {line.text}
      </span>
    </div>
  );
}
