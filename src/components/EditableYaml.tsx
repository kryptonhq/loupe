import { useEffect, useRef, useState } from "react";
import { YamlView } from "./YamlView";
import { ApplyConfirm } from "./ApplyConfirm";
import { useCluster } from "../lib/clusterContext";
import {
  api,
  errorMessage,
  isConflict,
  type EditTarget,
  type Guard,
} from "../lib/api";

// The YAML tab, in both its readings: a highlighted view, and — for the
// kinds the cluster lets us write — an editor over the same text.
//
// Two rules drive the whole component. An edit in progress is never
// thrown away: not by a background refetch, not by a failed save, not by
// pressing Escape. And a save that fails leaves the user exactly where
// they were, with their text and the reason it was refused, because the
// alternative is retyping an edit blind.

interface EditableYamlProps {
  source: string;
  /// The object being edited. Null for a kind the cluster will not
  /// accept updates to, which renders read-only rather than offering a
  /// button that always fails.
  target: EditTarget | null;
  /// Called after a successful apply, with the stored YAML. The parent
  /// refetches so the rest of the page catches up.
  onApplied: (yaml: string) => void;
  /// The connected context, named in the confirmation. Taken from the
  /// surrounding cluster scope when not given, which is how every page
  /// uses it; passed explicitly only in tests.
  context?: string | null;
  /// What the connected context allows. A read-only context is not
  /// offered an editor at all — the backend would refuse the write, and
  /// a button that always fails is worse than no button.
  guard?: Guard;
}

export function EditableYaml({
  source,
  target,
  onApplied,
  context: contextProp,
  guard: guardProp,
}: EditableYamlProps) {
  const scope = useCluster();
  const context = contextProp ?? scope.context;
  const guard = guardProp ?? scope.guard;

  // Null means "not editing". The draft is deliberately independent of
  // `source`: while it exists, nothing the server says overwrites it.
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (draft !== null && !confirming) textarea.current?.focus();
  }, [draft !== null, confirming]);

  const writable = target !== null && guard !== "readOnly";

  if (draft === null) {
    return (
      <div className="relative h-full">
        {writable && (
          <button
            onClick={() => {
              setError(null);
              setDraft(source);
            }}
            className="glass-overlay absolute right-20 top-2 z-20 px-2 py-1 text-2xs text-content-secondary transition-colors duration-150 ease-swift hover:text-content"
          >
            Edit
          </button>
        )}
        {target && guard === "readOnly" && (
          // Said out loud rather than left as an absent button, so the
          // reason is legible and the user knows where to change it.
          <span
            className="glass-overlay absolute right-20 top-2 z-20 px-2 py-1 text-2xs text-content-muted"
            title={`${context ?? "This context"} is marked read-only in Loupe`}
          >
            Read-only
          </span>
        )}
        <YamlView source={source} />
      </div>
    );
  }

  if (confirming && target) {
    return (
      <ApplyConfirm
        target={target}
        original={source}
        edited={draft}
        context={context ?? "this cluster"}
        guard={guard}
        busy={saving}
        onCancel={() => setConfirming(false)}
        onConfirm={save}
      />
    );
  }

  const dirty = draft !== source;

  async function save() {
    if (!target || draft === null) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.applyYaml(target, draft);
      // Leave edit mode only on success. The parent re-renders with the
      // stored YAML, which carries the resourceVersion the next edit
      // needs.
      setDraft(null);
      setConfirming(false);
      onApplied(result.yaml);
    } catch (e) {
      // Back to the editor with the text intact — the confirmation has
      // nothing useful to show once the write has been refused.
      setConfirming(false);
      setError(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-[rgb(var(--code-bg))]">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-1.5">
        <span className="truncate text-2xs text-content-muted">
          {dirty ? "Edited" : "Editing"} {target?.kind} {target?.name}
          {" · "}
          saved as a full replace
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => {
              setDraft(null);
              setError(null);
            }}
            disabled={saving}
            className="rounded-sm border px-2 py-1 text-2xs text-content-secondary transition-colors duration-150 ease-swift hover:bg-content/[0.06] hover:text-content disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            // Goes to the diff rather than straight to the cluster:
            // applying without looking is how outages start.
            onClick={() => setConfirming(true)}
            // Saving an unchanged document would burn a resourceVersion
            // and could only ever fail or do nothing.
            disabled={saving || !dirty}
            className="rounded-sm bg-accent/[0.18] px-2 py-1 text-2xs font-medium text-accent transition-colors duration-150 ease-swift hover:bg-accent/[0.26] disabled:opacity-40 disabled:hover:bg-accent/[0.18]"
          >
            Review &amp; apply
          </button>
        </span>
      </div>

      {error != null && (
        <div
          role="alert"
          className="animate-fade-in flex items-start justify-between gap-3 border-b border-danger/20 bg-danger/[0.08] px-3 py-2 text-xs text-danger"
        >
          <span className="min-w-0">{errorMessage(error)}</span>
          {isConflict(error) && (
            // A conflict is the one failure with an obvious next step,
            // so offer it rather than making the user find Refresh.
            <button
              onClick={() => {
                setDraft(null);
                setError(null);
                onApplied(source);
              }}
              className="shrink-0 rounded-sm border border-danger/30 px-2 py-0.5 text-2xs transition-colors hover:bg-danger/[0.12]"
            >
              Discard &amp; reload
            </button>
          )}
        </div>
      )}

      <textarea
        ref={textarea}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        aria-label="Object YAML"
        // Tab indents rather than leaving the field: YAML is indentation
        // and a tab key that escapes the editor makes it unusable.
        onKeyDown={(e) => {
          if (e.key !== "Tab") return;
          e.preventDefault();
          const el = e.currentTarget;
          const { selectionStart: start, selectionEnd: end } = el;
          setDraft(draft.slice(0, start) + "  " + draft.slice(end));
          // Restore the caret after React re-renders the value.
          requestAnimationFrame(() => {
            el.selectionStart = el.selectionEnd = start + 2;
          });
        }}
        className="min-h-0 flex-1 resize-none bg-transparent px-4 py-2 font-mono text-xs leading-[1.6] text-[rgb(var(--code-fg))] outline-none"
      />
    </div>
  );
}
